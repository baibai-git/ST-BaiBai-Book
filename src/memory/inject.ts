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
import { getLeaf, leafValid } from './apply';
import { fmtItems, fmtPlans } from './prompts';
import { memory } from './store';
import type { LeafExtra, MemSummary } from './types';

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
 * 一条叶子是否「已启用」(应注入)。
 * 生成与使用解耦:叶子对所有楼层提前生成,但只有当它所在消息已被隐藏(is_system,
 * 原文移出主上下文)时才注入顶替原文;仍在保留窗口发全文的叶子暂不注入,避免与全文重复。
 */
function leafActiveAt(chat: STMessage[] | null, i: number): boolean {
  if (!chat) return false;
  return chat[i]?.is_system === true;
}

/** 统一视图节点:叶子来自 chat 扫描,压缩节点来自森林,childIds 跨存储连接 */
interface ViewNode {
  id: string;
  kind: 'leaf' | 'comp';
  text: string;
  timeLabel?: string;
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

/** 把选出的节点拼成历史摘要文本块(带时间标签前缀);空则返回空串 */
export function renderHistoryNodes(nodes: ViewNode[]): string {
  return nodes.map(n => (n.timeLabel ? `【${n.timeLabel}】${n.text}` : n.text)).join('\n\n');
}

/**
 * 组合注入文本:已启用的历史摘要 + 当前结构化状态(时间/地点/物品/未了结计划)。
 * 空记忆 / 无启用摘要时,相应段落省略;整体为空时返回空串(注入空串等于清除)。
 */
export function buildInjectionText(): string {
  const parts: string[] = [];
  const chat = getContext()?.chat ?? null;

  // A. 历史摘要:从森林选「最高存活压缩层」节点(被收纳的不重复、窗口内全文叶子不注入)
  const sums = selectInjectionNodes(memory.summaries, chat);
  if (sums.length) {
    parts.push(`[历史剧情摘要]\n${renderHistoryNodes(sums)}`);
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
