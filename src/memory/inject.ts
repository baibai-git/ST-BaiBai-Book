/**
 * 把记忆注入回主对话上下文。
 *
 * 机制:走 ST 标准的 setExtensionPrompt(key, value, position, depth, scan, role, filter),
 * 而不是手动 splice eventData.chat。setExtensionPrompt 是持久化的——一次设置后,
 * 每次主对话生成都会带上,直到下次用同 key 覆盖。所以只需「记忆变了就刷新」即可。
 *
 * 与隐藏机制配套:旧楼层被 is_system=true 踢出主上下文(见 engine.ts),
 * 这里把它们压缩后的摘要 + 当前结构化状态作为 system 提示重新注入,
 * 主模型因此仍能感知被隐藏的剧情。历史摘要放在聊天顶部附近,当前状态贴近最近对话。
 */

import { apiSettings, engineActiveHere } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { getLeaf, leafValid } from './apply';
import { fmtItems, fmtPlans } from './prompts';
import { memory } from './store';
import { compactTimeLabel, formatRange, timeTagPrompt } from './timeTag';
import type { LeafExtra, MemSummary } from './types';

// 以下常量来源:SillyTavern public/script.js
//   extension_prompt_types.IN_CHAT = 1   (script.js:486)
//   extension_prompt_roles.SYSTEM = 0    (script.js:494)
// getContext() 未暴露这两个枚举,故硬编码并注明出处。
const IN_CHAT = 1;
const ROLE_SYSTEM = 0;

/** 旧版单槽位 key;刷新时清空,避免升级后 D2 残留重复注入 */
const LEGACY_INJECT_KEY = 'baibai_book_memory';
/** 拆分后的 setExtensionPrompt keys;同 key 重复 set 即覆盖,天然幂等 */
const HISTORY_INJECT_KEY = 'baibai_book_memory_history';
const STATE_INJECT_KEY = 'baibai_book_memory_state';
/** 时间标签固定提示词槽:注入主对话,要求每条正文前后输出 <bbs_start>/<bbs_end> */
const TIMETAG_INJECT_KEY = 'baibai_book_time_tag';
/** 历史摘要尽量放到聊天上下文顶部;当前状态贴近最近对话 */
const HISTORY_INJECT_DEPTH = 9999;
const STATE_INJECT_DEPTH_AFTER_LATEST_AI = 1;
const STATE_INJECT_DEPTH_BEFORE_LATEST_AI = 2;
/** 时间标签提示词贴近最近对话(浅 depth),作为对「下一条回复」的强指令 */
const TIMETAG_INJECT_DEPTH = 1;

/**
 * 一条叶子是否「已启用」(应注入)。
 * 生成与使用解耦:叶子对所有楼层提前生成,但只有当它所在消息已被隐藏(is_system,
 * 原文移出主上下文)时才注入顶替原文;仍在保留窗口发全文的叶子暂不注入,避免与全文重复。
 */
function leafActiveAt(chat: STMessage[] | null, i: number): boolean {
  if (!chat) return false;
  return chat[i]?.is_system === true;
}

/** 用于决定状态快照相对最新 AI 楼的位置;与 engine.ts 的可追踪 AI 楼规则保持一致。 */
function isTrackableAiMessage(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.extra?.bbs_hidden) return true;
  return !m.is_system;
}

/**
 * 当前状态的注入位置:
 *  - 最新 AI 已有有效摘要 → 状态已包含它,放在它之后(D1)。
 *  - 最新 AI 尚无有效摘要 → 状态不包含它,保持放在它之前(D2)。
 */
function resolveStateInjectionDepth(chat: STMessage[] | null): number {
  if (!chat) return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (!isTrackableAiMessage(chat[i])) continue;
    return leafValid(chat[i]) ? STATE_INJECT_DEPTH_AFTER_LATEST_AI : STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
  }
  return STATE_INJECT_DEPTH_BEFORE_LATEST_AI;
}

/** 统一视图节点:叶子来自 chat 扫描,压缩节点来自森林,childIds 跨存储连接 */
interface ViewNode {
  id: string;
  kind: 'leaf' | 'comp';
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // 旧数据回退
  createdAt: number;
  childIds: string[]; // comp 才有
  msgIndex: number; // leaf 才有意义(排序键);comp 取 -1
  active: boolean; // leaf:所在消息已隐藏
}

/** 构建统一森林视图:叶子(leafValid)+ 压缩节点,根 = 未被任何 childIds 引用者 */
function buildView(
  summaries: MemSummary[],
  chat: STMessage[] | null,
): { byId: Map<string, ViewNode>; roots: ViewNode[] } {
  const byId = new Map<string, ViewNode>();

  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      if (!leafValid(chat[i])) continue; // 陈旧叶子不进视图 → 不注入
      const leaf = getLeaf(chat[i]) as LeafExtra;
      byId.set(leaf.id, {
        id: leaf.id,
        kind: 'leaf',
        text: leaf.text,
        timeStart: leaf.timeStart,
        timeEnd: leaf.timeEnd,
        timeLabel: leaf.timeLabel,
        createdAt: leaf.createdAt,
        childIds: [],
        msgIndex: i,
        active: leafActiveAt(chat, i),
      });
    }
  }
  for (const s of summaries) {
    byId.set(s.id, {
      id: s.id,
      kind: 'comp',
      text: s.text,
      timeStart: s.timeStart,
      timeEnd: s.timeEnd,
      timeLabel: s.timeLabel,
      createdAt: s.createdAt,
      childIds: s.childIds ?? [],
      msgIndex: -1,
      active: false,
    });
  }

  const referenced = new Set<string>();
  for (const s of summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const roots = [...byId.values()].filter(n => !referenced.has(n.id));
  return { byId, roots };
}

/**
 * 通用节点选择:每个「合格」叶子由其祖先链上**最高的、全部后代叶子都合格**的节点代表一次
 * (省 token);否则压缩节点降级、逐子递归。叶子「合格」由 leafEligible 判定。
 *  - 注入场景:合格 = 已隐藏(active),用 selectInjectionNodes。
 *  - 分析历史场景:合格 = 楼层在被分析楼之前,用 selectHistoryNodesBefore。
 */
function selectNodes(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  const { byId, roots } = buildView(summaries, chat);

  const collectLeaves = (n: ViewNode, acc: ViewNode[]): void => {
    if (n.kind === 'leaf') {
      acc.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) collectLeaves(c, acc);
    }
  };
  const allDescEligible = (n: ViewNode): boolean => {
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length > 0 && ls.every(leafEligible);
  };

  const chosen: ViewNode[] = [];
  const visit = (n: ViewNode): void => {
    if (n.kind === 'leaf') {
      if (leafEligible(n)) chosen.push(n);
      return;
    }
    if (allDescEligible(n)) {
      chosen.push(n);
      return;
    }
    for (const cid of n.childIds) {
      const c = byId.get(cid);
      if (c) visit(c);
    }
  };
  for (const r of roots) visit(r);

  // 时间序拼接:叶子用楼层序;压缩节点用其最早后代叶子的楼层序
  const sortKey = (n: ViewNode): number => {
    if (n.kind === 'leaf') return n.msgIndex;
    const ls: ViewNode[] = [];
    collectLeaves(n, ls);
    return ls.length ? Math.min(...ls.map(l => l.msgIndex)) : Number.MAX_SAFE_INTEGER;
  };
  return chosen.sort((a, b) => sortKey(a) - sortKey(b));
}

/**
 * 选出注入用的节点:每个「已启用(已隐藏)」叶子由其祖先链最高的全-启用节点代表一次;
 * 窗口内仍发全文的叶子不注入。
 */
export function selectInjectionNodes(summaries: MemSummary[], chat: STMessage[] | null): ViewNode[] {
  return selectNodes(summaries, chat, n => n.active);
}

/**
 * 选出「被分析楼之前」的历史节点,供生成摘要时注入上下文:
 * 楼层 < beforeIndex 的叶子,由其祖先链最高的「全部后代都在 beforeIndex 之前」的节点代表一次
 * (有总结就用总结的压缩文本)。不要求隐藏。
 */
export function selectHistoryNodesBefore(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  beforeIndex: number,
): ViewNode[] {
  return selectNodes(summaries, chat, n => n.msgIndex >= 0 && n.msgIndex < beforeIndex);
}

/** 节点展示时间:新数据用起止合成,旧数据回退 timeLabel */
function nodeTime(n: ViewNode): string {
  if (n.timeStart || n.timeEnd) return formatRange(n.timeStart, n.timeEnd);
  return n.timeLabel ? compactTimeLabel(n.timeLabel) : '';
}

/** 把选出的节点拼成历史摘要文本块(带时间标签前缀);空则返回空串 */
export function renderHistoryNodes(nodes: ViewNode[]): string {
  return nodes
    .map(n => {
      const t = nodeTime(n);
      return t ? `【${t}】${n.text}` : n.text;
    })
    .join('\n\n');
}

/** 组合历史摘要注入文本;无启用摘要时返回空串(注入空串等于清除)。 */
export function buildHistoryInjectionText(): string {
  const chat = getContext()?.chat ?? null;

  // 从森林选「最高存活压缩层」节点(被收纳的不重复、窗口内全文叶子不注入)
  const sums = selectInjectionNodes(memory.summaries, chat);
  if (!sums.length) return '';
  return `[历史剧情摘要]\n${renderHistoryNodes(sums)}`;
}

/** 组合当前结构化状态注入文本;无有意义状态时返回空串。 */
export function buildStateInjectionText(): string {
  const st: string[] = [];
  if (memory.state.time) st.push(`当前时间:${memory.state.time}`);
  if (memory.state.location) st.push(`当前地点:${memory.state.location}`);
  st.push(`物品清单:\n${fmtItems(memory.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc })))}`);
  const openPlans = memory.plans
    .filter(p => p.status === 'open')
    .map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime }));
  st.push(`未了结的计划/悬念:\n${fmtPlans(openPlans)}`);

  // 状态块在有任何有意义内容时才注入(物品/计划即使空也会有「(无)」占位,
  // 但只要存在摘要或时间/地点就值得带上整块)
  const hasState = memory.state.time || memory.state.location || memory.items.length || openPlans.length;
  if (!hasState) return '';
  return `[当前状态]\n${st.join('\n')}`;
}

/**
 * 组合注入文本:已启用的历史摘要 + 当前结构化状态(时间/地点/物品/未了结计划)。
 * 保留给调试/兼容调用;实际注入由 refreshInjection 拆成两个 ST 槽位。
 */
export function buildInjectionText(): string {
  return [buildHistoryInjectionText(), buildStateInjectionText()].filter(Boolean).join('\n\n').trim();
}

/** 把当前记忆刷新到 ST 的扩展提示槽。ST 未就绪/旧版无此 API 时静默跳过。 */
export function refreshInjection(): void {
  // 引擎在此聊天不生效(总开关关 / 当前角色被排除):清掉已注入的槽。
  // 用 clearInjection 而非直接 return —— 切到被排除角色时必须抹掉上个聊天残留的注入。
  if (!engineActiveHere()) {
    clearInjection();
    return;
  }
  const ctx = getContext();
  const fn = ctx?.setExtensionPrompt;
  if (typeof fn !== 'function') return;
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  fn(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  fn(HISTORY_INJECT_KEY, buildHistoryInjectionText(), IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  fn(STATE_INJECT_KEY, buildStateInjectionText(), IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  // 时间标签固定提示词:跟随自动摘要开关注入主对话,关闭时注入空串(等于清除)
  fn(TIMETAG_INJECT_KEY, apiSettings.autoSummaryEnabled ? timeTagPrompt() : '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}

/** 清除注入(注入空串)。切到无记忆的聊天时由 refreshInjection 自动完成,此处供显式调用。 */
export function clearInjection(): void {
  const ctx = getContext();
  const stateDepth = resolveStateInjectionDepth(ctx?.chat ?? null);
  ctx?.setExtensionPrompt?.(LEGACY_INJECT_KEY, '', IN_CHAT, STATE_INJECT_DEPTH_BEFORE_LATEST_AI, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(HISTORY_INJECT_KEY, '', IN_CHAT, HISTORY_INJECT_DEPTH, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(STATE_INJECT_KEY, '', IN_CHAT, stateDepth, false, ROLE_SYSTEM, null);
  ctx?.setExtensionPrompt?.(TIMETAG_INJECT_KEY, '', IN_CHAT, TIMETAG_INJECT_DEPTH, false, ROLE_SYSTEM, null);
}
