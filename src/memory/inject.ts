/**
 * 把记忆注入回主对话上下文。
 *
 * 机制:走 ST 标准的 setExtensionPrompt(key, value, position, depth, scan, role, filter),
 * 而不是手动 splice eventData.chat。setExtensionPrompt 是持久化的——一次设置后,
 * 每次主对话生成都会带上,直到下次用同 key 覆盖。所以只需「记忆变了就刷新」即可。
 *
 * 与隐藏机制配套:旧楼层被 is_system=true 踢出主上下文(见 engine.ts),
 * 这里把它们压缩后的摘要 + 当前结构化状态作为 system 提示重新注入,
 * 主模型因此仍能感知被隐藏的剧情。
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { fmtItems, fmtPlans } from './prompts';
import { memory } from './store';

// 以下常量来源:SillyTavern public/script.js
//   extension_prompt_types.IN_CHAT = 1   (script.js:486)
//   extension_prompt_roles.SYSTEM = 0    (script.js:494)
// getContext() 未暴露这两个枚举,故硬编码并注明出处。
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** setExtensionPrompt 的唯一 key;同 key 重复 set 即覆盖,天然幂等 */
const INJECT_KEY = 'baibai_book_memory';
/** in-chat 注入深度(写死合理默认,不做 UI 旋钮) */
const INJECT_DEPTH = 2;

/**
 * 一条摘要是否「已启用」(应注入)。
 * 生成与使用解耦:摘要对所有楼层提前生成,但只有当它覆盖的楼层已被隐藏
 * (原文移出主上下文)时才注入,顶替原文;仍在保留窗口发全文的楼层,其摘要暂存不注入,
 * 避免与全文重复。判定:覆盖范围内仍存在于 chat 的消息全部为 is_system(已隐藏)。
 * 取不到 chat 时(ST 未就绪)回退为「全部启用」,避免丢记忆。
 */
export function isSummaryActive(coveredIndices: number[], chat: STMessage[] | null): boolean {
  if (!chat) return true;
  let sawExisting = false;
  for (const i of coveredIndices) {
    const m = chat[i];
    if (!m) continue; // 索引已失效(消息被删等)→ 不阻碍启用
    sawExisting = true;
    if (!m.is_system) return false; // 还有原文在主上下文里 → 尚未启用
  }
  // 覆盖的消息都已隐藏(或都已不存在)→ 启用
  return sawExisting || coveredIndices.length > 0;
}

/**
 * 组合注入文本:已启用的历史摘要 + 当前结构化状态(时间/地点/物品/未了结计划)。
 * 空记忆 / 无启用摘要时,相应段落省略;整体为空时返回空串(注入空串等于清除)。
 */
export function buildInjectionText(): string {
  const parts: string[] = [];
  const chat = getContext()?.chat ?? null;

  // A. 历史摘要:只注入「已启用」(覆盖楼层已隐藏)的,按时间先后拼接
  const sums = [...memory.summaries]
    .filter(s => isSummaryActive(s.coveredIndices, chat))
    .sort((a, b) => a.createdAt - b.createdAt);
  if (sums.length) {
    const body = sums.map(s => (s.timeLabel ? `【${s.timeLabel}】${s.text}` : s.text)).join('\n\n');
    parts.push(`[历史剧情摘要]\n${body}`);
  }

  // B. 当前结构化状态
  const st: string[] = [];
  if (memory.state.time) st.push(`当前时间:${memory.state.time}`);
  if (memory.state.location) st.push(`当前地点:${memory.state.location}`);
  st.push(`物品清单:\n${fmtItems(memory.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc })))}`);
  const openPlans = memory.plans
    .filter(p => p.status === 'open')
    .map(p => ({ kind: p.kind, content: p.content }));
  st.push(`未了结的计划/悬念:\n${fmtPlans(openPlans)}`);

  // 状态块在有任何有意义内容时才注入(物品/计划即使空也会有「(无)」占位,
  // 但只要存在摘要或时间/地点就值得带上整块)
  const hasState = memory.state.time || memory.state.location || memory.items.length || openPlans.length;
  if (hasState) {
    parts.push(`[当前状态]\n${st.join('\n')}`);
  }

  return parts.join('\n\n').trim();
}

/** 把当前记忆刷新到 ST 的扩展提示槽。ST 未就绪/旧版无此 API 时静默跳过。 */
export function refreshInjection(): void {
  const ctx = getContext();
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function') return;
  fn(INJECT_KEY, buildInjectionText(), IN_CHAT, INJECT_DEPTH, false, ROLE_SYSTEM, null);
}

/** 清除注入(注入空串)。切到无记忆的聊天时由 refreshInjection 自动完成,此处供显式调用。 */
export function clearInjection(): void {
  const ctx = getContext();
  ctx?.setExtensionPrompt?.(INJECT_KEY, '', IN_CHAT, INJECT_DEPTH, false, ROLE_SYSTEM, null);
}
