/**
 * 带数据创建新对话(Carryover)。
 *
 * 把当前聊天(一堆历史楼层 + 最近全文窗口)→ 新建一个对话,带过去:
 *  - 合并历史摘要(窗口之前的剧情,选最高存活压缩层拼接)= 种子叶子的 text;
 *  - 当前结构化状态(截止窗口起点的 items/plans)→ 编码成「全量 add」delta = 种子叶子的 delta;
 *  - 最近保留窗口的楼层(原样全文 + 各自叶子)搬过去。
 *
 * 新对话靠现成重放管线(deriveMemory:空白起步逐叶子 fold)还原状态——无需特殊载体,
 * 只要造一片把状态编码成全量 add 的「种子叶子」挂在 #0,并另置一条 L2 总结收纳它(承载合并摘要文本)。
 *
 * 同时(若向量记忆开):把源聊天的向量快照成一个 bundle,哈希写进新聊天 metadata.bbs_bundles(累加),
 * 使新对话能向量召回源聊天的旧剧情。
 */

import { getContext, getDoNewChat, setMessageText, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { apiSettings } from '@/api/settings';
import { deriveMemory, makeLeafId } from './apply';
import { resolveKeepStart } from './engine';
import { refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { latestStoryTime } from './timeTag';
import { memory, recomputeDerived, saveMemory, flushLeavesNow } from './store';
import type { JsonValue, LeafExtra, MemSummary, StoredDelta } from './types';
import { isBaiBaoKuAvailable, vecBundleCreate } from '@/api/baibaoku';
import { appendBundleHash, BUNDLES_META_KEY, currentBundleHashes, currentVectorDb } from './vector/scope';

/** 携带计划:供 UI 预览「将携带多少」。 */
export interface CarryoverPlan {
  /** 保留窗口起点(此索引起的楼层搬去新对话) */
  carryStart: number;
  /** 实际要搬的消息条数(窗口内非系统楼) */
  carryCount: number;
  /** 其中 AI 楼条数 */
  aiCount: number;
  /** 合并历史摘要字符数(0 = 无历史可摘) */
  recapLen: number;
  /** 当前是否有可携带数据 */
  hasData: boolean;
}

function cloneJsonRecord(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortJson(v);
    }
    return out;
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortJson(a)) === JSON.stringify(sortJson(b));
}

function deltaHasData(delta: StoredDelta): boolean {
  return !!(
    delta.time ||
    delta.location ||
    delta.locationPath?.length ||
    (delta.protagonist && Object.keys(delta.protagonist).length) ||
    delta.items?.add?.length ||
    delta.items?.update?.length ||
    delta.items?.remove?.length ||
    delta.scenes?.add?.length ||
    delta.scenes?.update?.length ||
    delta.scenes?.reparent?.length ||
    delta.scenes?.remove?.length ||
    delta.npcs?.add?.length ||
    delta.npcs?.update?.length ||
    delta.npcs?.remove?.length ||
    delta.plans?.add?.length ||
    delta.plans?.resolve?.length ||
    delta.plans?.remove?.length ||
    delta.plans?.reopen?.length ||
    delta.varOps?.length
  );
}

/** 把「截止窗口起点的派生状态」编码成全量 add 的 StoredDelta(种子叶子的 delta)。 */
function encodeStateAsDelta(state: ReturnType<typeof deriveMemory>): StoredDelta {
  const delta: StoredDelta = {};
  if (state.state.time) delta.time = state.state.time;
  if (state.state.location) {
    delta.location = state.state.location;
    if (state.state.locationPath?.length) delta.locationPath = state.state.locationPath;
  }
  if (Object.values(state.protagonist).some(Boolean)) {
    delta.protagonist = { ...state.protagonist };
  }

  if (state.items.length) {
    delta.items = {
      add: state.items.map(i => ({
        name: i.name,
        qty: i.qty,
        desc: i.desc,
        carried: i.carried,
        location: i.location,
      })),
    };
  }
  if (state.scenes.length) {
    delta.scenes = {
      add: [...state.scenes]
        .sort((a, b) => a.path.length - b.path.length || a.createdAt - b.createdAt || a.name.localeCompare(b.name))
        .map(s => ({
          path: [...s.path],
          desc: s.desc,
        })),
    };
  }
  if (state.npcs.length) {
    delta.npcs = {
      add: state.npcs.map(n => ({
        name: n.name,
        gender: n.gender,
        title: n.title,
        desc: n.desc,
        personality: n.personality,
        outfit: n.outfit,
        condition: n.condition,
        important: n.important,
        follow: n.follow,
        location: n.location,
      })),
    };
  }
  const openPlans = state.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    delta.plans = {
      add: openPlans.map(p => ({
        kind: p.kind,
        content: p.content,
        createdTime: p.createdTime,
        targetTime: p.targetTime,
      })),
    };
  }
  const initialVars = deriveMemory(null).vars;
  if (!sameJson(state.vars, initialVars)) {
    delta.varOps = [{ op: 'set', path: '', value: cloneJsonRecord(state.vars) }];
  }
  return delta;
}

/** 深拷贝一条要搬运的消息,取消隐藏、保留叶子。 */
function sanitizeCarryMessage(m: STMessage): STMessage {
  const clone: STMessage = JSON.parse(JSON.stringify(m));
  clone.is_system = false;
  if (clone.extra && 'bbs_hidden' in clone.extra) {
    const { bbs_hidden: _h, ...rest } = clone.extra;
    clone.extra = rest;
  }
  return clone;
}

/** 计算携带计划(不产生副作用),供 UI 预览。 */
export function computeCarryoverPlan(): CarryoverPlan {
  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  const carryStart = resolveKeepStart(chat);

  let carryCount = 0;
  let aiCount = 0;
  for (let i = carryStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    // ST 原生系统楼(带 type)不搬;真实楼(含被隐藏的)搬
    if (m.is_system && m.extra?.type) continue;
    carryCount++;
    if (!m.is_user) aiCount++;
  }

  const recap = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, carryStart));
  const seedDelta = encodeStateAsDelta(deriveMemory(chat, carryStart));
  return {
    carryStart,
    carryCount,
    aiCount,
    recapLen: recap.length,
    hasData: chat.length > 0 && (carryCount > 0 || recap.length > 0 || deltaHasData(seedDelta)),
  };
}

/**
 * 执行带数据创建新对话。返回是否成功。
 * 全程 try/catch:失败 toast 并尽量不破坏当前聊天(doNewChat 前只读不写源)。
 */
export async function createNewChatWithCarryover(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('SillyTavern 上下文不可用', 'error');
    return false;
  }
  if (ctx.groupId) {
    toast('群聊暂不支持带数据建新对话', 'warning');
    return false;
  }
  const sourceChat = ctx.chat ?? [];
  if (!sourceChat.length) {
    toast('当前对话没有可携带的数据', 'warning');
    return false;
  }

  const doNewChat = await getDoNewChat();
  if (!doNewChat) {
    toast('无法创建新对话(ST 接口不可用)', 'error');
    return false;
  }

  // ===== 1. 在建新对话前,从源聊天提取要携带的一切(只读) =====
  const carryStart = resolveKeepStart(sourceChat);
  const sourceChatId = ctx.getCurrentChatId?.() ?? null;
  const parentBundles = currentBundleHashes(); // 源聊天已携带的 bundle 哈希(将继承给新聊天)

  // 截止窗口起点的派生状态 → 种子叶子 delta(窗口楼层自己的叶子会继续累加,故截到窗口前避免重复)
  const stateBefore = deriveMemory(sourceChat, carryStart);
  const seedDelta = encodeStateAsDelta(stateBefore);

  // 合并历史摘要(窗口之前的剧情) = 种子叶子 text
  const mergedSummary = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, sourceChat, carryStart));

  // 种子叶子的时间锚:截止窗口前的状态时间(无则故事最新时间)
  const seedTime = stateBefore.state.time || latestStoryTime(sourceChat) || '';

  // 搬运的窗口楼层(深拷贝、取消隐藏、保留叶子)
  const carryMessages: STMessage[] = [];
  for (let i = carryStart; i < sourceChat.length; i++) {
    const m = sourceChat[i];
    if (!m) continue;
    if (m.is_system && m.extra?.type) continue; // 原生系统楼不搬
    carryMessages.push(sanitizeCarryMessage(m));
  }

  if (!mergedSummary && !carryMessages.length && !deltaHasData(seedDelta)) {
    toast('当前对话没有可携带的数据', 'warning');
    return false;
  }

  // ===== 2. 先建 bundle 拿哈希(向量记忆开 + 源聊天有 id 时);失败仅警告,不阻断建聊天 =====
  let newBundleHash: string | null = null;
  const vecDb = currentVectorDb();
  if (apiSettings.vector.enabled && vecDb && sourceChatId) {
    try {
      if (await isBaiBaoKuAvailable()) {
        const { hash } = await vecBundleCreate(vecDb, sourceChatId);
        newBundleHash = hash;
      }
    } catch (e) {
      console.warn('[柏宝书向量] 建 bundle 失败(新对话将不带源向量召回):', e);
    }
  }

  // ===== 3. 建新对话并切入 =====
  try {
    await ctx.saveChat();
    await doNewChat({ deleteCurrentChat: false });
  } catch (e) {
    toast(`创建新对话失败:${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }

  // ===== 4. 写入新对话(此刻 ctx.chat 已指向新聊天) =====
  try {
    const targetCtx = getContext();
    if (!targetCtx) throw new Error('新对话上下文不可用');
    const targetChat = targetCtx.chat ?? [];

    // 确保有 #0 锚点楼:种子叶子(承载全量状态 delta + 合并摘要文本)必须挂在一条 #0 上。
    // 卡有开场白 → 复用 #0 当锚点(清空正文、设系统楼,删其余开场白);
    // 卡**空开场白** → getChat 不会 push 任何楼,targetChat 为空,此处主动造一条锚点楼。
    //   (这是之前漏掉的分支:空开场白卡会让整个锚点块被跳过,导致窗口外摘要/状态全丢。)
    let anchor: STMessage;
    if (targetChat.length > 0) {
      // 只在「新对话是全新无 user 楼」时清开场白,避免误删用户已有内容
      const hasUser = targetChat.some(m => m.is_user);
      if (!hasUser && carryMessages.length > 0) {
        targetChat.splice(1); // 留 #0,删其余开场白
      }
      anchor = targetChat[0];
    } else {
      // 空开场白卡:造一条锚点楼放进 #0
      anchor = {
        name: targetCtx.name2 || '',
        is_user: false,
        is_system: true,
        mes: '',
        extra: {},
      };
      targetChat.push(anchor);
    }
    anchor.is_system = true;
    setMessageText(anchor, '');
    // 种子叶子挂 #0.extra
    const seedLeaf: LeafExtra = {
      id: makeLeafId(),
      text: mergedSummary,
      delta: seedDelta,
      timeEnd: seedTime || undefined,
      timeStart: seedTime || undefined,
      createdAt: Date.now(),
      seed: true, // 种子叶子:承载旧对话合并总结,不进向量库(见 index.ts collectLeaves + LeafExtra.seed 注释)
      v: 1,
    };
    anchor.extra = { ...(anchor.extra ?? {}), bbs_leaf: seedLeaf };

    // 新对话森林:重置后放一条 L2 总结收纳种子叶子(承载合并摘要文本)。
    memory.summaries.splice(0, memory.summaries.length);
    if (mergedSummary) {
      const l2: MemSummary = {
        id: `sum_carry_${Date.now().toString(36)}`,
        text: mergedSummary,
        level: 2,
        createdAt: Date.now(),
        auto: true,
        timeStart: seedTime || undefined,
        timeEnd: seedTime || undefined,
        childIds: [seedLeaf.id],
      };
      memory.summaries.push(l2);
    }

    // 搬入窗口楼层
    for (const m of carryMessages) targetChat.push(m);

    // 写新对话 metadata.bbs_bundles(继承源 + 本次新哈希,累加去重)
    if (newBundleHash || parentBundles.length) {
      const meta = targetCtx.chatMetadata as Record<string, unknown>;
      if (newBundleHash) {
        appendBundleHash(meta, parentBundles, newBundleHash);
      } else {
        meta[BUNDLES_META_KEY] = [...parentBundles];
      }
    }

    // 落盘 + 重算 + 刷新
    recomputeDerived();
    saveMemory();
    flushLeavesNow();
    await targetCtx.saveChat();
    if (typeof targetCtx.saveMetadata === 'function') await targetCtx.saveMetadata();
    if (typeof targetCtx.reloadCurrentChat === 'function') await targetCtx.reloadCurrentChat();
    refreshInjection();

    toast(`已创建新对话:携带 AI ${carryMessages.filter(m => !m.is_user).length} 条,旧剧情摘要 ${mergedSummary ? '1' : '0'} 条`, 'success');
    return true;
  } catch (e) {
    toast(`写入新对话失败:${e instanceof Error ? e.message : String(e)}`, 'error');
    return false;
  }
}
