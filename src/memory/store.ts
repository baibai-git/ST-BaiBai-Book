import { getContext, type STMessage } from '@/st/context';
import { reactive } from 'vue';
import { deriveMemory, getLeaf, leafHash, leafValid } from './apply';
import { isAiFloor, pendingAiFloors } from './engine';
import type { BaibaiMemory, LeafExtra, MemSummary, StoredDelta } from './types';
import { createEmptyMemory, MEMORY_KEY, MEMORY_VERSION } from './types';

/**
 * 响应式记忆镜像。
 * 真源:① 压缩节点森林 = chat_metadata[MEMORY_KEY].summaries;② 叶子 = chat 各消息 extra.bbs_leaf。
 * state / items / plans 是从 chat 重放出的派生缓存,供 Vue 渲染。
 */
export const memory = reactive<BaibaiMemory>(createEmptyMemory());

/**
 * 给页面读的派生元信息(chat 非 reactive,UI 必须经此 reactive 通道):
 *  - hasLeaf:是否有任一有效叶子(无则禁用手动添加)。
 *  - leaves:供 summary 页展示的叶子列表(含陈旧标记)。
 */
export interface LeafView {
  id: string;
  text: string;
  timeLabel?: string;
  createdAt: number;
  msgIndex: number;
  active: boolean; // 所在消息已隐藏(is_system)
  stale: boolean; // 正文已变、尚未重摘
}
export const derivedMeta = reactive<{ hasLeaf: boolean; leaves: LeafView[]; pendingFloors: number[] }>({
  hasLeaf: false,
  leaves: [],
  pendingFloors: [],
});

/** 重放 chat 得到 state/items/plans,原地写回;并刷新 derivedMeta */
export function recomputeDerived(): void {
  const chat = getContext()?.chat ?? null;
  const d = deriveMemory(chat);
  memory.state.time = d.state.time;
  memory.state.location = d.state.location;
  memory.items.splice(0, memory.items.length, ...d.items);
  memory.plans.splice(0, memory.plans.length, ...d.plans);

  // derivedMeta:扫 chat 收集叶子(含陈旧)
  const leaves: LeafView[] = [];
  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      const m = chat[i];
      const leaf = getLeaf(m);
      if (!leaf) continue;
      const valid = leafValid(m);
      leaves.push({
        id: leaf.id,
        text: leaf.text,
        timeLabel: leaf.timeLabel,
        createdAt: leaf.createdAt,
        msgIndex: i,
        active: m.is_system === true,
        stale: !valid,
      });
    }
  }
  derivedMeta.leaves = leaves;
  derivedMeta.hasLeaf = leaves.some(l => !l.stale);
  // 待摘要楼层(AI 楼且无有效叶子),供摘要页「未摘要楼层」列表逐楼补摘
  derivedMeta.pendingFloors = chat ? pendingAiFloors(chat) : [];
}

/* ============ 落盘:叶子在 chat 文件,森林在 metadata ============ */

let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖落盘叶子(写进 chat 文件)。合并连续多楼摘要为一次 saveChat。 */
export function scheduleLeafFlush(): void {
  const ctx = getContext();
  if (!ctx?.saveChat) return;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void ctx.saveChat();
  }, 1500);
}

/** 立即落盘(切聊天/卸载前调用,避免丢未落盘叶子) */
export function flushLeavesNow(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const ctx = getContext();
  void ctx?.saveChat?.();
}

/** 把森林(压缩节点)写回 chat_metadata 并持久化。叶子不在这里。 */
export function saveMemory() {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  const snapshot: { version: number; summaries: MemSummary[] } = {
    version: MEMORY_VERSION,
    summaries: JSON.parse(JSON.stringify(memory.summaries)),
  };
  (ctx.chatMetadata as Record<string, unknown>)[MEMORY_KEY] = snapshot;
  ctx.saveMetadataDebounced?.();
}

/* ============ 迁移 v2 → v3 ============ */

/**
 * v2(叶子在森林、带 coveredIndices+delta)→ v3(叶子搬到消息 extra)。
 * 需 chat 上下文;无 chat 时返回 null(延后,下次 CHAT_CHANGED 重跑)。
 * 搬不动的叶子(索引越界/消息已删)其 delta 合并进一条兜底叶子挂到最后 AI 楼,保结构化 1:1。
 */
function migrateV2toV3(raw: Record<string, unknown>, chat: STMessage[] | null): BaibaiMemory | null {
  if (!chat || chat.length === 0) return null; // 延后

  const out = createEmptyMemory();
  out.version = MEMORY_VERSION;
  const oldSums = (Array.isArray(raw.summaries) ? raw.summaries : []) as Array<Record<string, unknown>>;

  const orphanDeltas: StoredDelta[] = [];

  // 1) 旧叶子(level0)→ 搬到对应 AI 楼的 extra(保留原 id)
  for (const s of oldSums) {
    if ((typeof s.level === 'number' ? s.level : 0) !== 0) continue;
    const cov = (Array.isArray(s.coveredIndices) ? s.coveredIndices : []) as number[];
    const delta = (s.delta ?? {}) as StoredDelta;

    // 定位挂靠的 AI 楼:coveredIndices 里最后一个 isAiFloor;退而求其次取最后一个存在的
    let target = -1;
    for (let k = cov.length - 1; k >= 0; k--) {
      if (isAiFloor(chat[cov[k]])) {
        target = cov[k];
        break;
      }
    }
    if (target < 0) {
      for (let k = cov.length - 1; k >= 0; k--) {
        if (chat[cov[k]]) {
          target = cov[k];
          break;
        }
      }
    }
    if (target < 0 || !chat[target] || chat[target].extra?.bbs_leaf) {
      orphanDeltas.push(delta); // 搬不动/目标已占用 → 兜底
      continue;
    }
    const leaf: LeafExtra = {
      id: String(s.id),
      text: String(s.text ?? ''),
      delta,
      timeLabel: s.timeLabel as string | undefined,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      srcHash: leafHash(chat[target].mes),
      v: 1,
    };
    chat[target].extra = { ...(chat[target].extra ?? {}), bbs_leaf: leaf };
  }

  // 1b) 兜底叶子:把搬不动的 delta 合并挂到最后一条 AI 楼
  if (orphanDeltas.length) {
    let last = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
      if (isAiFloor(chat[i])) {
        last = i;
        break;
      }
    }
    if (last >= 0 && !chat[last].extra?.bbs_leaf) {
      const merged: StoredDelta = {};
      for (const d of orphanDeltas) mergeStoredDelta(merged, d);
      chat[last].extra = {
        ...(chat[last].extra ?? {}),
        bbs_leaf: {
          id: `leaf_migrate_${Date.now().toString(36)}`,
          text: '(迁移:历史结构化状态)',
          delta: merged,
          createdAt: Date.now(),
          srcHash: leafHash(chat[last].mes),
          v: 1,
        },
      };
    }
  }

  // 2) 压缩节点(level≥1)原样保留进森林
  for (const s of oldSums) {
    if ((typeof s.level === 'number' ? s.level : 0) < 1) continue;
    out.summaries.push({
      id: String(s.id),
      text: String(s.text ?? ''),
      level: s.level as number,
      createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(),
      auto: s.auto !== false,
      timeLabel: s.timeLabel as string | undefined,
      childIds: Array.isArray(s.childIds) ? (s.childIds as string[]) : [],
    });
  }
  return out;
}

/** 迁移辅助:把 delta b 合并进 a(用于兜底叶子,简单拼接 add/op 数组,resolve 用稳定 id) */
function mergeStoredDelta(a: StoredDelta, b: StoredDelta): void {
  if (b.time) a.time = b.time;
  if (b.location) a.location = b.location;
  if (b.items) {
    const ai = (a.items ??= {});
    if (b.items.add?.length) (ai.add ??= []).push(...b.items.add);
    if (b.items.update?.length) (ai.update ??= []).push(...b.items.update);
    if (b.items.remove?.length) (ai.remove ??= []).push(...b.items.remove);
  }
  if (b.plans) {
    const ap = (a.plans ??= {});
    if (b.plans.add?.length) (ap.add ??= []).push(...b.plans.add);
    if (b.plans.resolve?.length) (ap.resolve ??= []).push(...b.plans.resolve);
    if (b.plans.remove?.length) (ap.remove ??= []).push(...b.plans.remove);
    if (b.plans.reopen?.length) (ap.reopen ??= []).push(...b.plans.reopen);
  }
}

/* ============ 载入 / 保存 ============ */

function assignForest(target: BaibaiMemory, summaries: MemSummary[]) {
  target.version = MEMORY_VERSION;
  target.summaries = summaries;
}

/** 从当前聊天载入森林 + 重算派生(必要时迁移) */
export function loadMemory() {
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[MEMORY_KEY] as Record<string, unknown> | undefined;
  const chat = ctx?.chat ?? null;

  if (raw && typeof raw === 'object') {
    const version = typeof raw.version === 'number' ? raw.version : 1;
    if (version >= MEMORY_VERSION) {
      assignForest(memory, (Array.isArray(raw.summaries) ? raw.summaries : []) as MemSummary[]);
    } else {
      const migrated = migrateV2toV3(raw, chat);
      if (migrated) {
        assignForest(memory, migrated.summaries);
        // 先把叶子落盘(saveChat)成功,再升 version 写 metadata,保证可重入
        flushLeavesNow();
        saveMemory();
      } else {
        // 延后迁移:暂用旧森林里的压缩节点(level≥1),叶子等下次 chat 就绪再搬
        const comps = (Array.isArray(raw.summaries) ? raw.summaries : []).filter(
          (s: Record<string, unknown>) => (typeof s.level === 'number' ? s.level : 0) >= 1,
        ) as MemSummary[];
        assignForest(memory, comps);
      }
    }
  } else {
    assignForest(memory, []);
  }
  recomputeDerived();
}

/** 监听聊天切换:切走前 flush 未落盘叶子,切来后重载 */
export function bindChatLifecycle() {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => {
    flushLeavesNow();
    loadMemory();
  });
  // 首次载入
  loadMemory();
}
