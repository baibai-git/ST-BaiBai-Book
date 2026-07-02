/**
 * 向量索引编排:把当前聊天的有效叶子同步进后端向量库(该角色的 chat:<chatId> scope)。
 *
 * 流程(增量、幂等):
 *  1. 扫 chat 收集有效叶子 → present = [{leafId, docHash}](docHash 按叶子摘要文本算)。
 *  2. vec/reconcile:后端删掉陈旧(重摘换 id/删楼/编辑失效),返回需 embed 的 leafId(新增或 hash 变了)。
 *  3. 对缺失叶子 embed 其摘要文本 → vec/upsert。
 * 同文本(同 hash)不重复 embed —— 这是「边玩边索引」不卡的关键。
 *
 * 调用时机:叶子生成/编辑/删除后(防抖触发,见 schedule)。全程 try/catch 静默,
 * 向量是增强项,失败绝不影响摘要主流程。
 */

import { getContext, type STMessage } from '@/st/context';
import { apiSettings, engineActiveHere } from '@/api/settings';
import type { VecItem } from '@/api/baibaoku';
import { resetVectorStoreProbe, vecClearScope, vecReconcile, vecUpsert } from './store';
import { getLeaf, leafValid } from '../apply';
import { memory } from '../store';
import { resolveKeepStart } from '../engine';
import { stripThinkBlocks } from '../timeTag';
import type { LeafExtra } from '../types';
import { embedTexts, encodeFloat32Base64 } from './embed';
import { currentChatId, currentVectorDb } from './scope';

/** 轻量稳定 hash(FNV-1a,16 进制);叶子摘要文本变了 hash 即变,触发重 embed。 */
function docHashOf(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface LeafForIndex {
  leafId: string;
  docHash: string;
  document: string; // 叶子摘要文本(向量化对象 + 摘要档回传)
  mesFull: string; // 楼层原文(全文档回传)
  storyTime: string;
  msgIndex: number;
}

/**
 * 叶子的故事时间,存为**未压缩**的完整起止段「起 - 止」(起止相同/缺一端则单点)。
 * 为何不压缩(不删结束端重复日期):召回端要从这串里拆回**完整结束时间**算相对时间,
 * 压缩后结束端会缺日期(如「06:55」)导致算不出相对。显示时召回端再 compactTimeLabel 压成区间。
 */
function leafStoryTime(leaf: LeafExtra): string {
  const start = leaf.timeStart?.trim() || '';
  const end = leaf.timeEnd?.trim() || '';
  if (start && end) return start === end ? start : `${start} - ${end}`;
  return start || end || leaf.timeLabel?.trim() || '';
}

/**
 * 种子叶子的 id 集合(carryover 挂 #0、承载旧对话合并总结的那条,不索引进向量库)。
 * 识别两条口径,任一命中即算:
 *  - 新数据:leaf.seed === true(carryover.ts 显式打标)。
 *  - 老数据(标记出现前建的 carryover 聊天):被 id 以 `sum_carry_` 开头的总结节点 childIds 收纳的叶子。
 * 这样已存在的老聊天无需迁移——reconcile 下次对账时会把这条陈旧索引自动删掉。
 */
function seedLeafIds(): Set<string> {
  const ids = new Set<string>();
  for (const s of memory.summaries) {
    if (!s.id.startsWith('sum_carry_')) continue;
    for (const c of s.childIds ?? []) ids.add(c);
  }
  return ids;
}

/** 扫当前 chat 收集所有有效叶子的索引素材(种子叶子除外)。 */
function collectLeaves(chat: STMessage[]): LeafForIndex[] {
  const seeds = seedLeafIds();
  const out: LeafForIndex[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i]) as LeafExtra;
    if (leaf.seed || seeds.has(leaf.id)) continue; // 种子叶子:承载整段总结,不进向量库(见 LeafExtra.seed)
    const document = (leaf.text ?? '').trim();
    if (!document) continue; // 空摘要不索引
    out.push({
      leafId: leaf.id,
      docHash: docHashOf(document),
      document,
      // 存近乎原文:只预剥思维链(确定性噪声,省空间且零风险),其余清洗(自定义标签等)
      // 留到召回时过 cleanBody——这样用户日后调整「自定义清洗标签」设置,老索引也即时生效,无需重建。
      mesFull: stripThinkBlocks(chat[i].mes),
      storyTime: leafStoryTime(leaf),
      msgIndex: i,
    });
  }
  return out;
}

let indexing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 向量记忆是否在当前聊天可索引(总开关开 + 当前角色未排除 + 向量开关开 + 进入了单角色聊天)。 */
export function vectorIndexableHere(): boolean {
  if (!engineActiveHere()) return false; // 插件总开关关 / 当前角色被排除 → 不索引
  if (!apiSettings.vector.enabled) return false;
  return !!currentVectorDb() && !!currentChatId();
}

/**
 * 把当前聊天的叶子同步进向量库(增量)。可被防抖 schedule 或手动「重建索引」直接调用。
 * @returns 实际 embed+upsert 的条数(0 = 全是增量命中或无可索引)。
 */
export async function syncVectorIndex(signal?: AbortSignal): Promise<number> {
  if (!vectorIndexableHere()) return 0;
  if (indexing) return 0;
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const scope = `chat:${chatId}`;

  indexing = true;
  try {
    const leaves = collectLeaves(chat);
    const present = leaves.map(l => ({ leafId: l.leafId, docHash: l.docHash }));

    // reconcile:删陈旧、得出需 embed 的 leafId。空 present 也要发(可能要清掉删光的旧索引)。
    const { missing } = await vecReconcile(database, scope, present);
    if (!missing.length) return 0;

    const missingSet = new Set(missing);
    const todo = leaves.filter(l => missingSet.has(l.leafId));
    return await embedAndUpsert(database, scope, todo, signal);
  } catch (e) {
    console.warn('[柏宝书向量] 索引同步失败(不影响摘要):', e);
    return 0;
  } finally {
    indexing = false;
  }
}

/** embed 一批叶子并 upsert 到指定 scope;返回实际写入条数。embedTexts 内部按 64 分批。 */
async function embedAndUpsert(database: string, scope: string, todo: LeafForIndex[], signal?: AbortSignal): Promise<number> {
  if (!todo.length) return 0;
  const vectors = await embedTexts(todo.map(l => l.document), signal);
  const items: VecItem[] = todo.map((l, i) => {
    const vec = vectors[i];
    return {
      leafId: l.leafId,
      docHash: l.docHash,
      vector: encodeFloat32Base64(vec),
      dim: vec.length,
      document: l.document,
      mesFull: l.mesFull,
      storyTime: l.storyTime,
      msgIndex: l.msgIndex,
    };
  });
  await vecUpsert(database, scope, items);
  return items.length;
}

/**
 * 召回前的「补齐窗口外缺失索引」:确保滑动窗口**之前**的叶子都已索引,才放行召回。
 *
 * 为何只补窗口外:窗口内的叶子召回本就排除(避免与全文重复),它们的索引留给防抖增量即可,
 * 不必阻塞生成;而窗口外的旧叶子是召回的真正目标,缺索引会直接漏召回——必须先补。
 *
 * 复用 reconcile 全量对账(同时清陈旧、得 missing),但只对「窗口外 missing」阻塞 embed。
 * 全程 try/catch 静默:补建失败不阻断召回(召回侧自有降级),更不影响生成。
 */
export async function ensureRecallIndex(signal?: AbortSignal): Promise<void> {
  if (!vectorIndexableHere()) return;
  if (indexing) return; // 正在跑防抖同步,让它去做,避免重复 embed
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return;

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const scope = `chat:${chatId}`;

  indexing = true;
  try {
    const leaves = collectLeaves(chat);
    const present = leaves.map(l => ({ leafId: l.leafId, docHash: l.docHash }));
    const { missing } = await vecReconcile(database, scope, present);
    if (!missing.length) return;

    // 只阻塞补窗口外(< keepStart)缺失的叶子;窗口内缺失交给防抖增量
    const keepStart = resolveKeepStart(chat);
    const missingSet = new Set(missing);
    const todo = leaves.filter(l => missingSet.has(l.leafId) && l.msgIndex < keepStart);
    if (todo.length) await embedAndUpsert(database, scope, todo, signal);
  } catch (e) {
    console.warn('[柏宝书向量] 召回前补建索引失败(降级为不补):', e);
  } finally {
    indexing = false;
  }
}

/**
 * 清空当前聊天的向量索引(只清 chat:<chatId> scope,不动继承的 bundle 快照)。
 * 用于「索引脏了/想重来」:清空后可用「重建」从头索引。返回删除条数。
 * 不走 vectorIndexableHere 闸门(用户手动操作,即便向量开关临时关也应允许清理),
 * 但仍需当前库+聊天 id 才有目标 scope。
 */
export async function clearVectorIndex(): Promise<number> {
  const database = currentVectorDb();
  const chatId = currentChatId();
  if (!database || !chatId) return 0;
  resetVectorStoreProbe(); // 手动维护前重测后端,后端刚就绪/刚停都能切到对的 store
  const { deleted } = await vecClearScope(database, `chat:${chatId}`);
  return deleted;
}

/** 防抖触发索引同步:叶子生成/编辑/删除后调用,合并连续变动为一次。 */
export function scheduleVectorIndex(): void {
  if (!vectorIndexableHere()) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void syncVectorIndex();
  }, 2500);
}
