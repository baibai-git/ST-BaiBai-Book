/**
 * 从旧版 Horae 迁移记忆数据。
 *
 * 关键事实:Horae 与柏宝书共用**同一批聊天文件的同一批消息对象**——Horae 把数据挂在
 * `chat[i].horae_meta`,柏宝书挂在 `chat[i].extra.bbs_leaf`,两者并存于同一条 msg 上。
 * 所以迁移直接读「当前打开聊天」的 `ctx.chat[i].horae_meta` 产出柏宝书数据,不跨文件。
 * 范式照搬 carryover.ts:读源 → 造叶子(挂 extra)+ 森林(写 metadata)+ 把最终状态编码成种子 delta。
 *
 * 模型映射(详见 memory 里的 horae-migration-feature):
 *  - 每个有叙事的 AI 楼 → 一片叶子;text = 该楼非摘要 events 的 summary 拼接。
 *  - Horae 时间是**时间点**(每层一个),柏宝书是**时间段**:叶子 timeEnd = 本层时间点,
 *    timeStart = 上一已知时间点(段的左界);缺失则沿用上一已知值(carry-forward)。
 *  - Horae autoSummaries(带 range/depth、嵌套 mergedSummaries)→ 柏宝书森林 comp 节点:
 *    递归 flatten,depth→level,childIds 由「直接子条目 + 范围内未被子条目覆盖的叶子」重建。
 *  - 物品/计划是 Horae 的**逐层快照**(非增量),按楼序折叠出最终态,整包作为 add-delta 挂到
 *    最后一片叶子(避免逐层重放重复累加)。
 *  - 弃掉柏宝书没有的:affection / npcs / costumes / mood / relationships / RPG / customTables。
 */

import { getContext, type STMessage } from '@/st/context';
import { toast } from '@/st/toast';
import { isAiFloor, syncHiddenNow } from './engine';
import { makeLeafId } from './apply';
import { flushLeavesNow, memory, recomputeDerived, saveMemory } from './store';
import type { ItemDelta, LeafExtra, MemSummary, StoredDelta } from './types';

/* ============ Horae 源数据形状(只取迁移用得到的字段) ============ */

interface HoraeTimestamp {
  story_date?: string;
  story_time?: string;
  absolute?: string;
}
interface HoraeEvent {
  level?: string;
  summary?: string;
  isSummary?: boolean;
  _summaryId?: string;
}
interface HoraeItemInfo {
  holder?: string;
  location?: string;
  description?: string;
}
interface HoraeAgendaItem {
  type?: string;
  date?: string;
  text?: string;
  done?: boolean;
}
interface HoraeSummaryEntry {
  id?: string;
  range?: [number, number];
  summaryText?: string;
  depth?: number;
  createdAt?: string;
  auto?: boolean;
  mergedSummaries?: HoraeSummaryEntry[];
}
interface HoraeMeta {
  timestamp?: HoraeTimestamp;
  scene?: { location?: string };
  items?: Record<string, HoraeItemInfo>;
  deletedItems?: string[];
  events?: HoraeEvent[];
  event?: HoraeEvent; // 旧格式:单个 event
  agenda?: HoraeAgendaItem[];
  deletedAgenda?: string[];
  _deletedAgendaTexts?: string[];
  _skipHorae?: boolean;
  autoSummaries?: HoraeSummaryEntry[];
}

/* ============ 小工具 ============ */

/** 取一条消息上的 horae_meta(可能没有) */
function horaeMeta(m: STMessage | undefined): HoraeMeta | undefined {
  return (m as unknown as { horae_meta?: HoraeMeta } | undefined)?.horae_meta;
}

/** 合成时间点字符串:date + time(各自可缺)。两者皆空 → ''。 */
function combineTime(ts: HoraeTimestamp | undefined): string {
  const d = (ts?.story_date ?? '').trim();
  const t = (ts?.story_time ?? '').trim();
  return [d, t].filter(Boolean).join(' ').trim();
}

/** 取一层的叙事文本:非摘要卡 events 的 summary 拼接(摘要卡 level='摘要'/isSummary 跳过)。 */
function narrativeOf(meta: HoraeMeta | undefined): string {
  if (!meta) return '';
  const events = meta.events ?? (meta.event ? [meta.event] : []);
  return events
    .filter(e => e && !e.isSummary && e.level !== '摘要')
    .map(e => (e.summary ?? '').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

// Horae getItemBaseName 用的量词集合(剥「(量词)」后缀);保持与源一致。
const COUNTING_CLASSIFIERS = '个把条块张根口份枚只颗支件套双对碗杯盘盆串束扎';
const RE_QTY_PAREN = /[(（]\s*(\d+(?:\.\d+)?)\s*[a-zA-Z一-鿿]*\s*[)）]\s*$/; // (3) (3个) (500g)
const RE_PURE_CLASSIFIER = new RegExp(`[(（][${COUNTING_CLASSIFIERS}][)）]\\s*$`);
// 消耗/归零标记:出现即视为该物品已没
const RE_CONSUMED = /[(（](已消耗|已用完|已销毁|已銷毀|消耗殆尽|消耗殆盡|消耗|用尽|用盡|consumed|used\s*up|destroyed|depleted)[)）]/i;
const RE_ZERO = /[(（]\s*0\s*[a-zA-Z一-鿿]*\s*[)）]\s*$/;

/** 从 Horae 物品名解析出基础名 + 数量。数量编码在名字括号里(如「苹果(3)」)。 */
function parseHoraeItemName(raw: string): { name: string; qty?: number; consumed: boolean } {
  let name = String(raw ?? '').trim();
  if (RE_ZERO.test(name) || RE_CONSUMED.test(name)) return { name: name, consumed: true };
  let qty: number | undefined;
  const m = name.match(RE_QTY_PAREN);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) qty = n;
    name = name.replace(RE_QTY_PAREN, '').trim();
  }
  name = name.replace(RE_PURE_CLASSIFIER, '').trim();
  return { name, qty, consumed: false };
}

/* ============ 迁移计划(预览,纯只读) ============ */

export interface MigrationPlan {
  /** 是否检测到任何 Horae 数据 */
  hasData: boolean;
  /** 有叙事可建叶子的 AI 楼数 */
  leafFloors: number;
  /** 可迁移的总结(压缩节点)数 */
  summaryCount: number;
  /** 最终库存物品数 */
  itemCount: number;
  /** 未了结计划/悬念数 */
  planCount: number;
  /** 当前柏宝书是否已有森林数据(将被覆盖) */
  willOverwrite: boolean;
}

/** 把 chat 折叠成最终库存(逐层快照前向合并 + 处理删除/消耗)。 */
function foldFinalItems(chat: STMessage[]): ItemDelta[] {
  // 按基础名归并(Horae 同物可能换写法),保留最后一次出现的描述/地点。
  const byKey = new Map<string, ItemDelta>();
  const keyOf = (name: string) => name.trim().toLowerCase();

  for (let i = 0; i < chat.length; i++) {
    const meta = horaeMeta(chat[i]);
    if (!meta || meta._skipHorae) continue;

    if (meta.items) {
      for (const [rawName, info] of Object.entries(meta.items)) {
        const { name, qty, consumed } = parseHoraeItemName(rawName);
        if (!name) continue;
        const k = keyOf(name);
        if (consumed) {
          byKey.delete(k);
          continue;
        }
        const loc = (info?.location ?? '').trim();
        const desc = (info?.description ?? '').trim();
        const entry: ItemDelta = byKey.get(k) ?? { name };
        entry.name = name; // 以最新写法为准
        if (qty !== undefined) entry.qty = qty;
        if (desc) entry.desc = desc;
        if (loc) {
          entry.location = loc;
          entry.carried = false;
        }
        byKey.set(k, entry);
      }
    }
    // 显式删除
    for (const del of meta.deletedItems ?? []) {
      const { name } = parseHoraeItemName(del);
      byKey.delete(keyOf(name));
    }
  }
  return [...byKey.values()];
}

/** 把 chat 折叠成最终「未了结计划/悬念」。 */
function foldOpenPlans(chat: STMessage[]): StoredDelta['plans'] {
  const deleted = new Set<string>();
  const norm = (s: unknown) => String(s ?? '').trim();
  // 先收集所有删除标记(各层 deletedAgenda + chat[0]._deletedAgendaTexts)
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const d of meta?.deletedAgenda ?? []) if (norm(d)) deleted.add(norm(d));
    for (const d of meta?._deletedAgendaTexts ?? []) if (norm(d)) deleted.add(norm(d));
  }
  // 前向合并 agenda(按 text 去重,后出现的覆盖)
  const byText = new Map<string, HoraeAgendaItem>();
  for (const m of chat) {
    const meta = horaeMeta(m);
    for (const a of meta?.agenda ?? []) {
      const text = norm(a?.text);
      if (!text) continue;
      byText.set(text, a);
    }
  }
  const add: NonNullable<StoredDelta['plans']>['add'] = [];
  for (const [text, a] of byText) {
    if (a.done) continue;
    if (deleted.has(text)) continue;
    const kind = a.type === '悬念' || a.type === '懸念' ? 'suspense' : 'plan';
    add.push({ kind, content: text, createdTime: norm(a.date) || undefined });
  }
  return add.length ? { add } : undefined;
}

/** 递归 flatten Horae autoSummaries(嵌套 mergedSummaries),返回 [条目, 父id]。 */
function flattenHoraeSummaries(
  tops: HoraeSummaryEntry[],
): Array<{ entry: HoraeSummaryEntry; parentId: string | null }> {
  const out: Array<{ entry: HoraeSummaryEntry; parentId: string | null }> = [];
  const walk = (entry: HoraeSummaryEntry, parentId: string | null) => {
    if (!entry?.id) return;
    out.push({ entry, parentId });
    for (const child of entry.mergedSummaries ?? []) walk(child, entry.id);
  };
  for (const t of tops) walk(t, null);
  return out;
}

/** 计算迁移计划(只读,不产生副作用),供 UI 预览与按钮启停。 */
export function computeMigrationPlan(): MigrationPlan {
  const ctx = getContext();
  const chat = ctx?.getCurrentChatId?.() ? ctx?.chat ?? [] : [];

  let leafFloors = 0;
  for (let i = 0; i < chat.length; i++) {
    if (!isAiFloor(chat[i])) continue;
    if (narrativeOf(horaeMeta(chat[i]))) leafFloors++;
  }

  const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
  const summaryCount = flattenHoraeSummaries(tops).length;

  const items = foldFinalItems(chat);
  const plans = foldOpenPlans(chat);

  const hasData =
    leafFloors > 0 || summaryCount > 0 || items.length > 0 || !!plans?.add?.length;

  return {
    hasData,
    leafFloors,
    summaryCount,
    itemCount: items.length,
    planCount: plans?.add?.length ?? 0,
    willOverwrite: memory.summaries.length > 0 || hasAnyLeaf(chat),
  };
}

/** chat 上是否已有柏宝书叶子(用于「将覆盖」提示)。 */
function hasAnyLeaf(chat: STMessage[]): boolean {
  return chat.some(m => !!m?.extra?.bbs_leaf);
}

/* ============ 执行迁移 ============ */

/**
 * 把当前聊天里的 Horae 数据迁移成柏宝书数据。返回是否成功。
 * 直接写当前 chat 的消息 extra(叶子)与 chatMetadata(森林),落盘后刷新。
 */
export async function runHoraeMigration(): Promise<boolean> {
  const ctx = getContext();
  if (!ctx) {
    toast('SillyTavern 上下文不可用', 'error');
    return false;
  }
  if (!ctx.getCurrentChatId?.()) {
    toast('请先进入一个聊天再迁移', 'warning');
    return false;
  }
  const chat = ctx.chat ?? [];
  if (!chat.length) {
    toast('当前聊天为空,无可迁移数据', 'warning');
    return false;
  }

  const plan = computeMigrationPlan();
  if (!plan.hasData) {
    toast('未在当前聊天检测到 Horae 旧数据', 'warning');
    return false;
  }

  try {
    // ===== 1. 为每个有叙事的 AI 楼造叶子(时间点→时间段) =====
    // aiFloors:按楼序的 AI 楼索引;每层 timeEnd=本层时间点,timeStart=上一层时间点。
    const aiFloors: number[] = [];
    for (let i = 0; i < chat.length; i++) if (isAiFloor(chat[i])) aiFloors.push(i);

    // 先算每个 AI 楼的「时间点」(carry-forward:本层无则沿用上一已知)
    const floorTime = new Map<number, string>();
    let lastKnown = '';
    for (const idx of aiFloors) {
      const t = combineTime(horaeMeta(chat[idx])?.timestamp);
      if (t) lastKnown = t;
      floorTime.set(idx, lastKnown);
    }

    // 楼 idx → 新建叶子 id(供森林 childIds 引用);仅有叙事的楼建叶子。
    const leafIdByFloor = new Map<number, string>();
    let prevTime = '';
    let lastLeafFloor = -1;
    for (let k = 0; k < aiFloors.length; k++) {
      const idx = aiFloors[k];
      const text = narrativeOf(horaeMeta(chat[idx]));
      const end = floorTime.get(idx) || '';
      // 段左界:上一已知时间点;首层用本层(start=end)。
      const start = prevTime || end;
      if (text) {
        const leaf: LeafExtra = {
          id: makeLeafId(),
          text,
          delta: {},
          timeStart: start || undefined,
          timeEnd: end || undefined,
          createdAt: Date.now() + k, // 单调递增,保证 tie-break 与楼序一致
          swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
          v: 1,
        };
        chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
        leafIdByFloor.set(idx, leaf.id);
        lastLeafFloor = idx;
      }
      if (end) prevTime = end;
    }

    // ===== 2. 把最终状态(物品/计划/时间/地点)编码成种子 delta,挂到最后一片叶子 =====
    // 若没有任何叙事叶子但有状态,造一条空文本叶子挂到最后一个 AI 楼承载它。
    const items = foldFinalItems(chat);
    const plans = foldOpenPlans(chat);
    const finalState = computeFinalState(chat);

    if (lastLeafFloor < 0 && aiFloors.length) {
      const idx = aiFloors[aiFloors.length - 1];
      const leaf: LeafExtra = {
        id: makeLeafId(),
        text: '',
        delta: {},
        timeEnd: floorTime.get(idx) || undefined,
        timeStart: floorTime.get(idx) || undefined,
        createdAt: Date.now() + aiFloors.length,
        swipe: typeof chat[idx].swipe_id === 'number' ? chat[idx].swipe_id : 0,
        v: 1,
      };
      chat[idx].extra = { ...(chat[idx].extra ?? {}), bbs_leaf: leaf };
      leafIdByFloor.set(idx, leaf.id);
      lastLeafFloor = idx;
    }

    if (lastLeafFloor >= 0) {
      const seedLeaf = chat[lastLeafFloor].extra!.bbs_leaf as LeafExtra;
      const delta: StoredDelta = seedLeaf.delta ?? (seedLeaf.delta = {});
      if (items.length) delta.items = { add: items };
      if (plans) delta.plans = plans;
      if (finalState.time) delta.time = finalState.time;
      if (finalState.location) delta.location = finalState.location;
    }

    // ===== 3. 重建森林(autoSummaries → comp 节点) =====
    const tops = (chat[0] && horaeMeta(chat[0])?.autoSummaries) || [];
    const flat = flattenHoraeSummaries(tops);

    // 子条目集合:供「直接覆盖范围内、未被子条目覆盖的叶子」计算 childIds。
    const childEntriesByParent = new Map<string, HoraeSummaryEntry[]>();
    for (const { entry, parentId } of flat) {
      if (parentId) {
        const arr = childEntriesByParent.get(parentId) ?? [];
        arr.push(entry);
        childEntriesByParent.set(parentId, arr);
      }
    }

    const newSummaries: MemSummary[] = [];
    let order = 0;
    for (const { entry } of flat) {
      const id = String(entry.id);
      const level = normalizeDepth(entry.depth);
      const childEntries = childEntriesByParent.get(id) ?? [];
      const childRanges = childEntries.map(c => c.range).filter(Boolean) as [number, number][];

      // childIds:① 直接子条目 id(下层 comp);② 本范围内、未被任何子条目范围覆盖的叶子 id。
      const childIds: string[] = childEntries.map(c => String(c.id));
      const range = entry.range;
      if (range) {
        for (let i = range[0]; i <= range[1]; i++) {
          const leafId = leafIdByFloor.get(i);
          if (!leafId) continue;
          if (childRanges.some(([a, b]) => i >= a && i <= b)) continue; // 已属某子条目
          childIds.push(leafId);
        }
      }
      if (!childIds.length) continue; // 空壳节点(范围内叶子全没了)跳过

      // 时间段:范围内首尾叶子的起止
      const { start, end } = rangeTimeSpan(range, floorTime, leafIdByFloor);
      newSummaries.push({
        id,
        text: (entry.summaryText ?? '').trim(),
        level,
        createdAt: Date.now() + order++,
        auto: entry.auto !== false,
        timeStart: start || undefined,
        timeEnd: end || undefined,
        childIds,
      });
    }

    // ===== 4. 写回:森林覆盖,叶子已写进 extra;落盘 + 重算 =====
    memory.summaries.splice(0, memory.summaries.length, ...newSummaries);
    recomputeDerived();
    saveMemory();
    flushLeavesNow();
    if (typeof ctx.saveMetadata === 'function') await ctx.saveMetadata();
    // 检测一次隐藏:把已被摘要覆盖、滚出保留窗口的旧楼层隐藏掉(复用摘要收尾同款逻辑),
    // 避免迁移后全文与摘要在上下文里重复;内部已含刷新注入。
    await syncHiddenNow();

    toast(
      `迁移完成:叶子 ${leafIdByFloor.size} 片 / 总结 ${newSummaries.length} 条 / 物品 ${items.length} / 计划 ${plans?.add?.length ?? 0}`,
      'success',
    );
    return true;
  } catch (e) {
    toast(`迁移失败:${e instanceof Error ? e.message : String(e)}`, 'error');
    console.error('[柏宝书] Horae 迁移失败:', e);
    return false;
  }
}

/** 规整 depth → 柏宝书 level(≥1)。 */
function normalizeDepth(depth: unknown): number {
  const n = typeof depth === 'number' ? depth : parseInt(String(depth ?? ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** 某 comp 范围内的时间段:取范围内有叶子的最早起始与最晚结束。 */
function rangeTimeSpan(
  range: [number, number] | undefined,
  floorTime: Map<number, string>,
  leafIdByFloor: Map<number, string>,
): { start: string; end: string } {
  if (!range) return { start: '', end: '' };
  let start = '';
  let end = '';
  for (let i = range[0]; i <= range[1]; i++) {
    if (!leafIdByFloor.has(i)) continue;
    const t = floorTime.get(i) || '';
    if (t && !start) start = t;
    if (t) end = t;
  }
  return { start, end };
}

/** 折叠出最终时间/地点(逐层前向覆盖)。 */
function computeFinalState(chat: STMessage[]): { time: string; location: string } {
  let time = '';
  let location = '';
  for (const m of chat) {
    const meta = horaeMeta(m);
    if (!meta || meta._skipHorae) continue;
    const t = combineTime(meta.timestamp);
    if (t) time = t;
    const loc = (meta.scene?.location ?? '').trim();
    if (loc) location = loc;
  }
  return { time, location };
}
