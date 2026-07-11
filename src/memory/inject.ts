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
import { buildSceneLocationIndex, classifyNpcPresence, findCurrentSceneId, getLeaf, itemReachableAtScene, leafValid } from './apply';
import { fmtItems, fmtPlans, fmtResolvedPlans, renderVarsState, selectRecentResolvedPlans, MEMORY_BRIEFING_NOTE, MEMORY_BRIEFING_END } from './prompts';
import { memory } from './store';
import { compactTimeLabel, formatRange, latestStoryTime, splitTimeLabel, timeTagPrompt } from './timeTag';
import { relativeTimeLabel, weekdayLabel } from './timeRel';
import { selectViewNodes, type ViewNode } from './select';
import type { LeafExtra, MemItem, MemNpc, MemProtagonist, MemScene, MemSummary } from './types';

// 摘要页列表复用同一套选择逻辑,经此 re-export(纯算法在 select.ts,零依赖、可单测)
export { selectViewNodes, type ViewNode };

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
/** 时间标签提示词独立注入到 D0(最底、最贴近下一条回复),作为对「下一条回复」的最强指令,
 *  不与状态快照(D1/D2)同层 */
const TIMETAG_INJECT_DEPTH = 0;

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
  if (m.extra?.bbs_omit) return false;
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

/** 构建统一森林视图:叶子(leafValid)+ 压缩节点,根 = 未被任何 childIds 引用者 */
function buildView(
  summaries: MemSummary[],
  chat: STMessage[] | null,
): { byId: Map<string, ViewNode>; roots: ViewNode[] } {
  const byId = new Map<string, ViewNode>();

  if (chat) {
    for (let i = 0; i < chat.length; i++) {
      if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不进注入视图
      if (!leafValid(chat[i])) continue; // 陈旧叶子不进视图 → 不注入
      const leaf = getLeaf(chat[i]) as LeafExtra;
      byId.set(leaf.id, {
        id: leaf.id,
        kind: 'leaf',
        level: 0,
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
      level: s.level,
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
 *
 * ⚠️ 完好性(intact):一个压缩节点的某个 childId 指向的叶子若已失效(翻页到别的 swipe →
 * leafValid=false → 不在 byId 里),则该节点**不完整**,不能作为整体代表注入(它的压缩文本
 * 嵌着失效那页的旧叙事,会与当前正文冲突)。此时降级递归,改用它**仍完好的子节点**各自代表:
 * 受影响的那条链一路拆到叶子层、跳过失效叶子,而旁支完好的子节点(如同层另一条 L1)整条保留。
 * 节点失活只是「当前不展示/不注入」,森林数据不删除——翻回原页 leafValid 恢复,即自动复活。
 */
function selectNodes(
  summaries: MemSummary[],
  chat: STMessage[] | null,
  leafEligible: (n: ViewNode) => boolean,
): ViewNode[] {
  return selectViewNodes(buildView(summaries, chat), leafEligible);
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

/**
 * 把选出的节点拼成只带绝对时间的历史摘要文本块;空则返回空串。
 * 这套渲染器供摘要/批量摘要/查询重写等副任务复用:它们各自有历史截止点,
 * 不能沿用主对话「相对当前最新剧情」的口径,因此这里刻意不计算相对时间。
 */
export function renderHistoryNodes(nodes: ViewNode[]): string {
  return nodes
    .map(n => {
      const t = nodeTime(n);
      return t ? `【${t}】${n.text}` : n.text;
    })
    .join('\n\n');
}

/** 节点的「事件时间」:用结束时间(剧情已到达的时刻);缺则回退起始,再回退旧 timeLabel 的结束端 */
function nodeEventTime(n: ViewNode): string {
  if (n.timeEnd) return n.timeEnd;
  if (n.timeStart) return n.timeStart;
  return n.timeLabel ? splitTimeLabel(n.timeLabel).end ?? '' : '';
}

/** 取节点未压缩的起止时间;新字段优先,缺失端再从旧 timeLabel 回退。 */
function nodeTimeRange(n: ViewNode): { start: string; end: string } {
  const legacy = n.timeLabel ? splitTimeLabel(n.timeLabel) : {};
  return {
    start: n.timeStart?.trim() || legacy.start?.trim() || '',
    end: n.timeEnd?.trim() || legacy.end?.trim() || '',
  };
}

/** 给一个完整时间点追加相对时间与周几;无法推断的部分自然省略。 */
function timePointWithRelative(time: string, now: string): string {
  const value = time.trim();
  if (!value) return '';
  const parts = [relativeTimeLabel(value, now), weekdayLabel(value)].filter(Boolean);
  return parts.length ? `${value}(${parts.join('·')})` : value;
}

/**
 * 总结节点跨越一段时间,不能用单个「昨天」代表整段。
 * 因此起点、终点分别相对同一个 now 计算,并保留两端完整绝对时间:
 * 【1988/9/28 22:00(前天·周三) - 1988/9/29 08:00(昨天·周四)】
 */
function nodeRangeWithRelative(n: ViewNode, now: string): string {
  const { start, end } = nodeTimeRange(n);
  if (!start && !end) return '';
  if (start && end && start !== end) {
    return `${timePointWithRelative(start, now)} - ${timePointWithRelative(end, now)}`;
  }
  return timePointWithRelative(start || end, now);
}

/**
 * 主对话注入/公开历史宏使用:为历史节点补相对时间,帮模型感知剧情距离。
 * 参照点 now = 故事内最新时间;无法解析相对差的(架空纪年等)降级为只显示绝对时间。
 * 不并入 renderHistoryNodes —— 后者被摘要模型等副任务复用,截止点和参照点不同。
 *
 * 叶子摘要指向单楼,维持【(昨天·周三) 绝对时间】格式。
 * 总结跨多楼,按起止端分别标注为【起始(相对) - 结束(相对)】,避免用单个相对时间误代表整段。
 * 周几与相对时间并入同一个括号;仅标准公历带年份才有周几(weekdayLabel 自带门槛)。
 */
export function renderHistoryNodesWithRelative(nodes: ViewNode[], now: string): string {
  return nodes
    .map(n => {
      if (n.kind === 'comp') {
        const range = nodeRangeWithRelative(n, now);
        return range ? `【${range}】${n.text}` : n.text;
      }
      const t = nodeTime(n);
      if (!t) return n.text;
      const event = nodeEventTime(n);
      const parts = [relativeTimeLabel(event, now), weekdayLabel(event)].filter(Boolean);
      return parts.length ? `【(${parts.join('·')}) ${t}】${n.text}` : `【${t}】${n.text}`;
    })
    .join('\n\n');
}

/** 组合历史摘要注入文本;无启用摘要时返回空串(注入空串等于清除)。 */
export function buildHistoryInjectionText(): string {
  const chat = getContext()?.chat ?? null;

  // 从森林选「最高存活压缩层」节点(被收纳的不重复、窗口内全文叶子不注入)
  const sums = selectInjectionNodes(memory.summaries, chat);
  if (!sums.length) return '';
  // 注入路径带相对时间前缀;参照点 = 故事内最新时间(读正文标签,不受是否已摘影响)
  // 首尾私密简报框定,避免主模型把摘要当成要复述/输出的模板
  return `${MEMORY_BRIEFING_NOTE}\n[历史剧情摘要]\n${renderHistoryNodesWithRelative(sums, latestStoryTime(chat))}\n${MEMORY_BRIEFING_END}`;
}

/**
 * 在场景树里定位「当前节点」:优先 AI 给的权威 locationPath,否则按 here 收紧模糊匹配。
 * 与场景页共用 apply.findCurrentSceneId(单一来源,杜绝页面/注入分叉),这里再把 id 解析回节点。
 * 找不到返回 null(退回纯字符串行为)。
 */
function findCurrentScene(scenes: MemScene[], here: string, locationPath?: string[]): MemScene | null {
  const id = findCurrentSceneId(scenes, here, locationPath);
  if (!id) return null;
  return scenes.find(s => s.id === id) ?? null;
}

/** 回溯祖先链(由粗到细,含当前节点本身)。 */
function sceneChain(scenes: MemScene[], node: MemScene | null): MemScene[] {
  if (!node) return [];
  const byId = new Map(scenes.map(s => [s.id, s]));
  const chain: MemScene[] = [];
  let cur: MemScene | undefined = node;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

/**
 * 渲染场景注入块(分三档省 token):
 *  - 当前地点 + 祖先链:逐级「名称(描述)」详细。
 *  - 其他去过的地点:仅列名称(完整路径名),帮 AI 复用既有命名、避免重复记录。
 * 无场景数据返回空串。
 */
function fmtSceneContext(scenes: MemScene[], here: string, locationPath?: string[]): string {
  if (!scenes.length) return '';
  const current = findCurrentScene(scenes, here, locationPath);
  const chain = sceneChain(scenes, current);
  const chainIds = new Set(chain.map(s => s.id));

  const lines: string[] = [];
  if (chain.length) {
    const detailed = chain
      .map(n => (oneLine(n.desc) ? `${n.name}(${oneLine(n.desc)})` : n.name))
      .join(' › ');
    lines.push(`当前所在(由大到小):${detailed}`);
  }
  // 其他地点:仅名称(用完整路径表达层级),排除已在祖先链里详述的
  const others = scenes
    .filter(s => !chainIds.has(s.id))
    .map(s => s.path.join(' › '));
  if (others.length) {
    lines.push(`其他已知地点(仅名称,勿重复记录):\n${others.map(o => `  - ${o}`).join('\n')}`);
  }
  return lines.join('\n');
}

/**
 * 单行化:把值里的换行/回车折叠成空格。
 * NPC 名册是「一个角色一行、字段用 ;/—— 拼接」的格式,值内含换行会把一条信息拆成多行、
 * 后续行丢掉「  - 」前缀,破坏注入结构、误导 AI。故所有内联字段渲染前都过此函数。
 * (UI 里字段可软换行显示,但注入必须压平——trim 只去首尾,拦不住中间换行。)
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** 主角不参与 NPC 在场分档;已有字段始终完整注入。 */
function fmtProtagonistContext(protagonist: MemProtagonist, name: string): string {
  const fields: Array<[string, string | undefined]> = [
    ['性别', protagonist.gender],
    ['身份', protagonist.identity],
    ['外貌', protagonist.appearance],
    ['着装', protagonist.outfit],
    ['状态', protagonist.condition],
  ];
  const lines = fields
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  if (!lines.length) return '';
  return `${oneLine(name) || '主角'}:\n${lines.join('\n')}`;
}

/** 把 NPC 的「即时状态」(着装/状态/所在)拼成一段尾注;无则空串。供在场与主要角色组复用。 */
function npcStateTail(n: MemNpc, withPlace: boolean): string {
  const tail: string[] = [];
  if (oneLine(n.outfit)) tail.push(`着装:${oneLine(n.outfit)}`);
  if (oneLine(n.condition)) tail.push(`状态:${oneLine(n.condition)}`);
  if (withPlace) {
    if (n.follow) tail.push('随行');
    else if (oneLine(n.location)) tail.push(`在:${oneLine(n.location)}`);
  }
  return tail.length ? ` 〔${tail.join(';')}〕` : '';
}

/**
 * 渲染 NPC 名册注入块(分四档省 token):
 *  - **主要角色**(important):永远全量置顶,**突出即时状态面板**(着装/状态/所在),身份/性格/外貌从简。
 *  - 在场(随行 / 所在地=主角当前节点)→ 全量:名 + 性别 + 身份 + 性格 + 外貌 + 即时状态。
 *  - **同区域**(抬头最多一级就与主角共处)→ 轻量:名 + 性别 + 身份 + 性格 + 所在地。留个性格,免得 AI
 *    临时拉其出场时凭空 OOC;但砍掉外貌/即时状态这俩大头,人多时省得多。
 *  - 不在场(更上级祖先/更远旁支)→ 只发 名 + 性别 + 身份(title)。
 * **性别在所有档都发**(包括不在场),防 AI 搞错性别。无 NPC 返回空串。
 */
function fmtNpcContext(npcs: MemNpc[], scenes: MemScene[], here: string, locationPath?: string[]): string {
  if (!npcs.length) return '';
  const main: MemNpc[] = [];
  const present: MemNpc[] = [];
  const nearby: MemNpc[] = [];
  const absent: MemNpc[] = [];
  for (const n of npcs) {
    if (n.important) { main.push(n); continue; } // 主要角色单列,不再进在场判定
    const p = classifyNpcPresence(n, scenes, here, locationPath); // 与 NPC 页共用同一权威判定
    if (p === 'present') present.push(n);
    else if (p === 'nearby') nearby.push(n);
    else absent.push(n);
  }

  const lines: string[] = [];
  if (main.length) {
    // 主要角色:状态面板优先。身份留一句帮定位,外貌/性格从简(卡里通常已有),重点是即时状态。
    const detailed = main
      .map(n => {
        const gender = oneLine(n.gender) ? `·${oneLine(n.gender)}` : '';
        const title = oneLine(n.title) ? `·${oneLine(n.title)}` : '';
        const head = gender || title ? `${n.name}(${[gender, title].filter(Boolean).join('')})` : n.name;
        return `  - ${head}${npcStateTail(n, true)}`;
      })
      .join('\n');
    lines.push(`主要角色(核心主演,需始终保持其当前状态连贯):\n${detailed}`);
  }
  if (present.length) {
    const detailed = present
      .map(n => {
        const parts = [n.name];
        const inBracket: string[] = [];
        if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
        if (oneLine(n.title)) inBracket.push(oneLine(n.title));
        if (inBracket.length) parts.push(`(${inBracket.join('·')})`);
        const profile: string[] = [];
        if (oneLine(n.personality)) profile.push(`性格:${oneLine(n.personality)}`);
        if (oneLine(n.desc)) profile.push(oneLine(n.desc));
        const profileStr = profile.length ? ` —— ${profile.join(';')}` : '';
        const place = n.follow ? ' [随行]' : '';
        return `  - ${parts.join('')}${place}${profileStr}${npcStateTail(n, false)}`;
      })
      .join('\n');
    lines.push(`在场角色:\n${detailed}`);
  }
  if (nearby.length) {
    // 同区域:名 + 性别 + 身份 + 性格 + 所在地;砍掉外貌/即时状态。留性格以稳住临时出场时的人设。
    const brief = nearby
      .map(n => {
        const inBracket: string[] = [];
        if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
        if (oneLine(n.title)) inBracket.push(oneLine(n.title));
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const pers = oneLine(n.personality) ? ` —— 性格:${oneLine(n.personality)}` : '';
        const place = oneLine(n.location) ? ` [在:${oneLine(n.location)}]` : '';
        return `  - ${n.name}${bracket}${pers}${place}`;
      })
      .join('\n');
    lines.push(`同区域角色(在附近但未必照面;需要时可让其自然登场,勿凭空改设定):\n${brief}`);
  }
  if (absent.length) {
    // 不在场:仅名 + 性别 + 身份,按所在地括注;无外貌/性格/状态
    const brief = absent
      .map(n => {
        const inBracket: string[] = [];
        if (oneLine(n.gender)) inBracket.push(oneLine(n.gender));
        if (oneLine(n.title)) inBracket.push(oneLine(n.title));
        const bracket = inBracket.length ? `(${inBracket.join('·')})` : '';
        const loc = oneLine(n.location);
        return `  - ${n.name}${bracket}${loc ? ` [在:${loc}]` : ''}`;
      })
      .join('\n');
    lines.push(`其他已知角色(不在当前场景,仅名与身份):\n${brief}`);
  }
  return lines.join('\n');
}

/**
 * 渲染指定地点视角下的物品上下文。
 * 正常状态注入与「前往地点」草稿共用这一入口，确保寄存物品的可达判定不会分叉。
 */
function fmtItemContext(items: MemItem[], scenes: MemScene[], here: string, locationPath?: string[]): string[] {
  const current = findCurrentScene(scenes, here, locationPath);
  const sceneIndex = buildSceneLocationIndex(scenes);
  const reachable: MemItem[] = [];
  const elsewhere: MemItem[] = [];

  for (const item of items) {
    if (item.carried !== false || itemReachableAtScene(scenes, item.location, current, here, sceneIndex)) {
      reachable.push(item);
    } else {
      elsewhere.push(item);
    }
  }

  const blocks = [
    `物品清单:\n${fmtItems(reachable.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`,
  ];
  if (elsewhere.length) {
    const brief = elsewhere
      .map(i => `  - ${i.name}${typeof i.qty === 'number' ? ` ×${i.qty}` : ''}(存:${oneLine(i.location) || '某处'})`)
      .join('\n');
    blocks.push(`他处寄存物品(回到对应地点才有完整信息):\n${brief}`);
  }
  return blocks;
}

/**
 * 为场景页的「前往」操作生成可编辑的用户草稿。
 * 只临时把目标节点当作当前地点来计算场景、物品和 NPC 上下文，不修改 memory.state。
 */
export function buildTravelDraft(target: MemScene): string {
  const here = target.name;
  const locationPath = target.path;
  const destination = target.path.join(' › ');
  const blocks: string[] = [];

  const sceneBlock = fmtSceneContext(memory.scenes, here, locationPath);
  if (sceneBlock) blocks.push(`地点记忆:\n${sceneBlock}`);
  blocks.push(...fmtItemContext(memory.items, memory.scenes, here, locationPath));

  const npcBlock = fmtNpcContext(memory.npcs, memory.scenes, here, locationPath);
  if (npcBlock) blocks.push(`NPC名册:\n${npcBlock}`);

  return [
    `前往「${destination}」，请从抵达后继续剧情。`,
    `以下是抵达该地点后的相关记忆，请保持设定一致:\n${blocks.join('\n')}`,
  ].join('\n\n');
}

/** 组合当前结构化状态注入文本;无有意义状态时返回空串。 */
export function buildStateInjectionText(): string {
  // 仅摘要模式保留内部状态供副 API、页面和公开查询使用,主模型只接收剧情摘要。
  if (apiSettings.summaryOnlyMode) return '';

  const st: string[] = [];
  if (memory.state.time) {
    // 周几只在标准公历带年份时有(weekdayLabel 自带门槛),古风/架空时间不标
    const wd = weekdayLabel(memory.state.time);
    st.push(`当前时间:${memory.state.time}${wd ? ` (${wd})` : ''}`);
  }
  if (memory.state.location) st.push(`当前地点:${oneLine(memory.state.location)}`);

  const protagonistBlock = fmtProtagonistContext(memory.protagonist, getContext()?.name1 ?? '');
  if (protagonistBlock) st.push(`[主角当前状态]\n${protagonistBlock}`);

  const here = memory.state.location || '';
  const locPath = memory.state.locationPath;
  // 场景树:当前地点 + 祖先链(详细) + 其他地点(仅名称)。祖先链同时用于物品/NPC 可达判定。
  const sceneBlock = fmtSceneContext(memory.scenes, here, locPath);
  if (sceneBlock) st.push(`地点记忆:\n${sceneBlock}`);

  // 物品分两组省 token:可达(随身 / 存放地落在当前地点或其祖先链)发全量(名+量+描述);
  // 他处寄存的只发名+数量(砍掉描述这个大头),既省 token 又不至于让主模型以为东西没了。
  st.push(...fmtItemContext(memory.items, memory.scenes, here, locPath));
  // 注:近期物品变动不在此注入。改为摘要后写进对应楼层正文 </bbs_end> 之后(见 engine.ts),
  // 窗口内全文楼层天然可见、滚出窗口自然消失 —— 符合「物品变动只在那段时间有用」的取舍。

  // NPC 名册四档:在场发全量;同区域发名+身份+性格+所在地;不在场只发名+身份。NPC 越多省得越多。
  const npcBlock = fmtNpcContext(memory.npcs, memory.scenes, here, locPath);
  if (npcBlock) st.push(`NPC名册:\n${npcBlock}`);

  const openPlans = memory.plans
    .filter(p => p.status === 'open')
    .map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime }));
  st.push(`未了结的计划/悬念:\n${fmtPlans(openPlans)}`);

  // 近期已完成的计划/悬念:防 AI 把刚了结的当未完成又去推进。与副API摘要同口径,只差截止点
  // (这里用全量 memory.plans;副API用 deriveMemory(chat, beforeIndex).plans)。
  const recentResolved = selectRecentResolvedPlans(memory.plans, apiSettings.recentResolvedPlansCount);
  if (recentResolved.length) st.push(`近期已了结(已结案,含了结方式/原因;勿当未完成再推进/重复记录):\n${fmtResolvedPlans(recentResolved)}`);

  // 自定义变量:发当前状态 + 各字段「含义」给主模型(帮它理解并保持数值/设定连贯),明确框定为只读。
  // ⚠️ 绝不注入「变化规则」(rule)——那是给副API摘要用的「如何增删改」指令(含 set/assign 命令语法);
  //    主模型看到「何时怎么变」会误以为该在正文里输出/复述变量或命令。含义只描述「是什么」,给主模型安全。
  const varMeaning = (['global', 'char', 'chat'] as const)
    .map(t => memory.varTemplates[t].meaning.trim())
    .filter(Boolean)
    .join('\n\n');
  const hasVarState = Object.keys(memory.vars).length > 0;
  if (hasVarState) {
    let block = `自定义变量(当前状态,只读参考——严禁在正文里复述、罗列或输出这些变量/命令):\n${renderVarsState(memory.vars)}`;
    if (varMeaning) block += `\n变量含义(仅帮你理解上面的值,不要输出):\n${varMeaning}`;
    st.push(block);
  }

  // 状态块在有任何有意义内容时才注入(物品/计划即使空也会有「(无)」占位,
  // 但只要存在摘要或时间/地点就值得带上整块)
  const hasProtagonist = Object.values(memory.protagonist).some(value => !!oneLine(value));
  const hasState = memory.state.time || memory.state.location || hasProtagonist || memory.items.length || memory.scenes.length || memory.npcs.length || openPlans.length || hasVarState;
  if (!hasState) return '';
  // 首尾私密简报框定,避免主模型把状态快照当成要复述/输出的模板(正文后跟吐一份状态)
  return `${MEMORY_BRIEFING_NOTE}\n[当前状态]\n${st.join('\n')}\n${MEMORY_BRIEFING_END}`;
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
