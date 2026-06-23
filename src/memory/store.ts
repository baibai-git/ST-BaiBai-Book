import { getContext } from '@/st/context';
import { reactive } from 'vue';
import type { BaibaiMemory } from './types';
import { createEmptyMemory, MEMORY_KEY, MEMORY_VERSION } from './types';

/**
 * 响应式记忆镜像。
 * 真源是 chat_metadata[MEMORY_KEY];这里维护一份 reactive 副本供 Vue 渲染,
 * 每次写入后 flush 回 chat_metadata 并防抖持久化。
 */
export const memory = reactive<BaibaiMemory>(createEmptyMemory());

function assign(target: BaibaiMemory, src: BaibaiMemory) {
  target.version = src.version ?? MEMORY_VERSION;
  target.state = src.state ?? { time: '', location: '' };
  target.items = src.items ?? [];
  target.plans = src.plans ?? [];
  target.summaries = src.summaries ?? [];
}

/** 从当前聊天的 chat_metadata 载入记忆到响应式镜像 */
export function loadMemory() {
  const ctx = getContext();
  const meta = ctx?.chatMetadata as Record<string, unknown> | undefined;
  const raw = meta?.[MEMORY_KEY] as BaibaiMemory | undefined;
  if (raw && typeof raw === 'object') {
    assign(memory, { ...createEmptyMemory(), ...raw });
  } else {
    assign(memory, createEmptyMemory());
  }
}

/** 把响应式镜像写回 chat_metadata 并持久化 */
export function saveMemory() {
  const ctx = getContext();
  if (!ctx?.chatMetadata) return;
  // 写入纯对象快照,避免把 Vue proxy 存进去
  (ctx.chatMetadata as Record<string, unknown>)[MEMORY_KEY] = JSON.parse(JSON.stringify(memory));
  ctx.saveMetadataDebounced?.();
}

/** 监听聊天切换,自动重载记忆 */
export function bindChatLifecycle() {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  ctx.eventSource.on(ctx.eventTypes.CHAT_CHANGED, () => loadMemory());
  // 首次载入
  loadMemory();
}
