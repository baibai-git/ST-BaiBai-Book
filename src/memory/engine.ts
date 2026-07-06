import type { ChatMsg } from '@/api/client';
import { mainApiAvailable, requestCompletion, requestViaMainApi } from '@/api/client';
import { apiSettings, engineActiveHere, getChannelForTask } from '@/api/settings';
import type { TaskType } from '@/api/settings';
import type { STMessage, WorldInfoEntry } from '@/st/context';
import { getContext, getCheckWorldInfo, getEjsTemplate, setMessageText } from '@/st/context';
import { toast } from '@/st/toast';
import { addSummary, deriveMemory, finalizeDelta, fmtVarOpsInline, getLeaf, itemChangesOf, leafValid, makeLeafId, pruneBrokenComps, syncItemLogFromMessage } from './apply';
import { extractJsonObject } from './json';
import { clearInjection, refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { buildBatchSummaryPrompt, buildBatchThinking, buildCharCardSystem, buildPersonaSystem, buildResummaryPrompt, buildSummaryPrompt, buildWorldInfoSystem, fmtItemLogInline, JAILBREAK_PROMPT, selectRecentResolvedPlans, THINKING_CHECKLIST, THINKING_PREFILL } from './prompts';
import { clampToTimeTags, cleanBody, parseTimeRange, syncTimeTagRegex, writeItemLogTag, writeVarLogTag } from './timeTag';
import { memory, recomputeDerived, scheduleLeafFlush } from './store';
import type { LeafExtra, SummaryDelta } from './types';
import { scheduleVectorIndex } from './vector';
import { clearRecallInjection } from './vector/recall';

/** 引擎运行状态(供 UI 显示) */
import { reactive, watch } from 'vue';
export const engineState = reactive({
  running: false,
  lastError: '' as string,
  lastRunAt: 0,
});

/**
 * 批量补摘运行状态(模块级单例,供 UI 跨「关窗重开」恢复进度/取消按钮)。
 * 放这里而非组件本地 ref:柏宝书窗口关闭会销毁组件、丢失本地 ref,但 batchBackfill 在本模块继续跑——
 * 关窗 ≠ 取消。重开后组件读这个单例即可恢复「补摘中 X/Y + 取消」的显示。
 */
export const batchState = reactive({
  running: false,
  done: 0,
  total: 0,
  cancelRequested: false, // 用户已点取消、等块边界生效
});

/** 请求取消正在进行的批量补摘(块边界生效,不打断进行中的块)。 */
export function cancelBatchBackfill(): void {
  if (batchState.running) batchState.cancelRequested = true;
}

let busy = false;
// 当前在飞的摘要完成信号:拦截器可 await 它(成功/失败都 resolve,永不 reject,故不会卡死生成)。
// 无在飞摘要时为 null。在 runSummary 头尾维护。
let currentRun: Promise<void> | null = null;
export function currentSummaryPromise(): Promise<void> | null {
  return currentRun;
}

/** 把消息渲染成给摘要模型的文本(cleanBody:裁正文段 + 整块删噪声标签 + 时间标签转文本) */
function renderMessages(chat: STMessage[], indices: number[], name1: string, name2: string): string {
  return indices
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      // 双标:既标发言方(用户/角色),又带人名 —— 摘要正文用人名,群聊也能区分谁说的
      const tag = m.is_user ? '用户' : '角色';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      // cleanBody:裁剪到 <bbs_start>…</bbs_end>(剔除状态栏等正文外格式)+ 整块删噪声标签
      //（思维链/注释/物品旁注/自定义标签)+ 时间标签转可读文本。不再裸删标签。
      return `【${tag}·${who}】${cleanBody(m.mes)}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** 把去空后的分段去重、join。世界书激活各来源统一收口于此(与旧行为一致)。 */
function joinWorldInfoChunks(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of chunks) {
    const t = c?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out.join('\n\n').trim();
}

/**
 * 判断某条条目是否应被排除:① 整本排除(world 命中名单);② 条目名(comment)命中任一规则。
 * 规则按正则编译、**大小写不敏感**(填 mvu 命中 [MVU]);普通名字天然=包含匹配。
 * 编译失败降级为字面子串包含(大小写不敏感)——用户填了带元字符的普通名字(如「(临时)」)
 * 也不会误伤,只是退化成子串比对。
 */
function isWorldInfoEntryExcluded(entry: WorldInfoEntry): boolean {
  const world = entry.world?.trim();
  if (world && apiSettings.excludedWorldNames.includes(world)) return true;
  const comment = entry.comment?.trim();
  if (!comment) return false;
  for (const raw of apiSettings.excludedWorldInfoPatterns) {
    const pat = raw.trim();
    if (!pat) continue;
    let hit = false;
    try {
      hit = new RegExp(pat, 'i').test(comment);
    } catch {
      hit = comment.toLowerCase().includes(pat.toLowerCase()); // 非法正则 → 退化为字面子串包含
    }
    if (hit) return true;
  }
  return false;
}

/**
 * 本轮待摘文本的扫描数组(各楼正文清洗后,带人名前缀帮助关键词命中角色名)。
 * checkWorldInfo / getWorldInfoPrompt 共用。
 */
function buildScanText(chat: STMessage[], targets: number[], name1: string, name2: string): string[] {
  return targets
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      return `${who}: ${clampToTimeTags(m.mes)}`;
    })
    .filter(Boolean);
}

// ST 内部:WI 实际预算 = world_info_budget(默认25%) × maxContext,超出即截断条目(蓝灯也不例外)。
// 摘要场景要「激活的一条都不漏」,故传一个极大的 maxContext,让预算大到不可能溢出。
// (若用户设了 world_info_budget_cap 上限,仍会被它封顶——那是用户显式的硬上限,尊重之。)
const HUGE_WI_CONTEXT = 1_000_000_000;

/**
 * 渲染世界书条目内容,让副 API 拿到「执行后」的成品而非原文:
 *   ① substituteParams 展开 {{宏}}(含 JS-Slash-Runner 经 MacrosParser 注册的自定义宏);
 *   ② 若装了 ST-Prompt-Template(提示词模板)且文本含 <% %>,调其执行器跑 EJS
 *      (如「按好感度切换人设」的条件条目)。
 * 复刻其官方 evaluateWIEntities 的顺序(先宏后 EJS)。开关 renderWorldInfoTemplates 关闭时整体跳过。
 *
 * 变量时点(floor):作为**截止楼层**传给 prepareContext 的第二参(导出接口签名是
 * (context, end),end 即 msg_id)。这样 EJS 里 getvar 读到的是**那一楼的楼层级变量快照**
 * (MVU 等按 message 级存储的框架天然对得上),而非当前最新——总结旧楼时才用当时的好感度等。
 *   - floor 省略(降级路径拿不到楼层)→ prepareContext 默认取最新楼。
 *   - 该楼变量若只在聊天级(单一最新)而无楼层快照 → 仍是最新值(优雅降级,不比原来差)。
 *
 * ⚠️ 含写变量(setvar 等)的 EJS 每次摘要会额外执行、污染状态,故给了开关让用户可关。
 * 单条失败不影响整体:退回该条上一步的文本(已展宏 / 原文),并打日志。
 */
async function renderWorldInfoContent(content: string, entry?: WorldInfoEntry, floor?: number): Promise<string> {
  if (!apiSettings.renderWorldInfoTemplates) return content;
  const ctx = getContext();
  // ① 展宏(substituteParams 不存在时保持原文)
  let text = typeof ctx?.substituteParams === 'function' ? ctx.substituteParams(content) : content;
  // ② 无 EJS 标签则无需调模板插件(省去 prepareContext/sandbox 开销)
  if (!text.includes('<%')) return text;
  const ejs = getEjsTemplate();
  if (!ejs) return text; // 未装 ST-Prompt-Template:只做了展宏
  try {
    // 第二参 end=floor:让 getvar 以「截止该楼」的变量快照求值;undefined 时接口默认取最新楼
    const env = await ejs.prepareContext({ world_info: entry }, floor);
    const out = await ejs.evalTemplate(text, env);
    if (typeof out === 'string') text = out;
  } catch (e) {
    console.log('[柏宝书] 世界书 EJS 渲染失败(退回未执行文本):', e);
  }
  return text;
}

/**
 * 降级路径:走 ST 暴露的 getWorldInfoPrompt(只拿拼好的字符串,**无法按名字过滤**)。
 * 仅当 checkWorldInfo 取不到时使用——此时排除设置不生效,但至少摘要照常带世界书,不崩。
 * 蓝灯/相关条目可能落在 before、after、depth(@深度)、作者注 任一位置,全部提取。
 */
async function fetchWorldInfoViaPrompt(scanText: string[], refFloor?: number): Promise<string> {
  const fn = getContext()?.getWorldInfoPrompt;
  if (typeof fn !== 'function') return '';
  const res = await fn(scanText, HUGE_WI_CONTEXT, true);
  if (!res) return '';
  const chunks: string[] = [];
  if (typeof res.worldInfoBefore === 'string') chunks.push(res.worldInfoBefore);
  if (typeof res.worldInfoAfter === 'string') chunks.push(res.worldInfoAfter);
  for (const d of res.worldInfoDepth ?? []) {
    for (const e of d?.entries ?? []) if (typeof e === 'string') chunks.push(e);
  }
  for (const e of res.anBefore ?? []) if (typeof e === 'string') chunks.push(e);
  for (const e of res.anAfter ?? []) if (typeof e === 'string') chunks.push(e);
  // 逐块渲染(展宏 + EJS);此路径拿不到条目对象,EJS 仅带当前状态上下文(无 world_info),但仍按 refFloor 取变量
  const rendered = await Promise.all(chunks.map(c => renderWorldInfoContent(c, undefined, refFloor)));
  return joinWorldInfoChunks(rendered);
}

/**
 * 按本轮待摘文本激活世界书条目(关键词触发 + constant 蓝灯),过滤后返回设定文本。
 * 优先走 checkWorldInfo:它返回**条目对象**(带 world/comment),据此按「整本排除」+「条目名规则」
 * 过滤掉不需要的条目(如全局挂载的附加知识书)。激活逻辑(扫描深度/递归/预算)全在其内部,不碰。
 * checkWorldInfo 取不到(旧版/路径变动)→ 降级到 getWorldInfoPrompt(不过滤,但摘要照常带书,不崩)。
 * 无激活条目 / 角色卡无世界书 / 出错 → 返回空串(不影响摘要正常运行)。
 */
async function fetchWorldInfo(chat: STMessage[], targets: number[], name1: string, name2: string): Promise<string> {
  const scanText = buildScanText(chat, targets, name1, name2);
  if (!scanText.length) return '';
  // 变量时点代表楼:取本批**最后一个 target 楼**(= 这段剧情结束时的状态,与「总结这段发生了什么」最匹配)。
  // targets 为升序 chat 索引;空则 undefined(降级取最新)。EJS 里 getvar 据此读该楼的历史变量快照。
  const refFloor = targets.length ? targets[targets.length - 1] : undefined;
  try {
    const check = await getCheckWorldInfo();
    if (!check) return await fetchWorldInfoViaPrompt(scanText, refFloor); // 降级:拿不到条目对象,无从过滤

    const res = await check(scanText, HUGE_WI_CONTEXT, true);
    const activated = res?.allActivatedEntries;
    if (!activated) return '';
    // allActivatedEntries 可能是 Set<entry> 或 Map<key,entry>,统一取 values
    const entries = activated instanceof Map ? [...activated.values()] : [...activated];
    // 逐条渲染(展宏 + 执行 EJS),让「按好感度切换人设」等动态条目拿到成品而非原文;变量按 refFloor 取历史值
    const chunks = await Promise.all(
      entries
        .filter(e => e && !isWorldInfoEntryExcluded(e))
        .map(e => renderWorldInfoContent(typeof e.content === 'string' ? e.content : '', e, refFloor)),
    );
    return joinWorldInfoChunks(chunks);
  } catch (e) {
    console.log('[柏宝书] 世界书激活失败(降级为不带设定):', e);
    return '';
  }
}

/**
 * 取当前角色卡的人设字段(description / personality / scenario)。
 * 有些卡把人设写在角色描述而非世界书里,摘要也需据此理解角色言行。
 *   - 三个字段都尝试,空的自动跳过(现代卡常只填 description);
 *   - 字段里可能含 {{char}}/{{user}} 宏,用 substituteParams 展开;
 *   - 群聊(characterId 为空)暂不带——多成员合并逻辑复杂,后续再做。
 * 取不到角色 / 全空 → 返回空串(降级,不影响摘要)。
 */
function fetchCharCard(): string {
  const ctx = getContext();
  if (!ctx || ctx.groupId) return ''; // 群聊暂不带
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return '';
  const ch = ctx.characters?.[Number(idx)] as Record<string, unknown> | undefined;
  if (!ch) return '';
  const sub = typeof ctx.substituteParams === 'function' ? ctx.substituteParams : (s: string) => s;
  const fields: Array<[string, string]> = [
    ['描述', String(ch.description ?? '')],
    ['性格', String(ch.personality ?? '')],
    ['情景', String(ch.scenario ?? '')],
  ];
  const parts: string[] = [];
  for (const [label, raw] of fields) {
    const t = sub(raw).trim();
    if (t) parts.push(`【${label}】\n${t}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * 取当前用户人设(persona / 用户设定)。
 * 走 ST 稳定宏 {{persona}}(= power_user.persona_description),substituteParams 展开即得;
 * 不去翻 power_user 全局,保持「只通过 context 接触宿主」。
 * 用途:摘要副API原本只知道角色卡({{char}} 一方),不知道主角({{user}})是谁,
 * 写 summary、判断「NPC 与 user 的互动」时缺一块。带上 persona 补齐这一侧。
 * 群聊同样适用(persona 独立于角色,不按 groupId 早退);未设置 persona / 取不到 → 空串(降级)。
 */
function fetchUserPersona(): string {
  const ctx = getContext();
  if (!ctx || typeof ctx.substituteParams !== 'function') return '';
  return ctx.substituteParams('{{persona}}').trim();
}

/**
 * 是否「可追踪的 AI 楼层」。与「是否对主 LLM 可见」解耦——隐藏与否都要算,只要它是真实的 AI 回复。
 *
 * 关键区分:`is_system=true` 有两种来源,不能一概排除:
 *   ① 被隐藏的真实 AI 回复(我们 /hide 的 → 带 extra.bbs_hidden;或用户/别的扩展 /hide 的 → 无标记)
 *      —— 这些是角色的真实发言,**必须算 AI 楼**,否则隐藏过的楼就漏摘(用户实测痛点)。
 *   ② ST 原生系统楼(/sys、/comment、叙事注入等)—— 这些带 extra.type,**不算**。
 * 据此:非用户、有正文、且不是「带 type 的原生系统楼」即为 AI 楼。普通可见回复 is_system=false 自然命中。
 */
export function isAiFloor(m: STMessage | undefined): boolean {
  // 番外楼(bbs_omit):对引擎彻底不存在——不摘、不总结、不重放、不注入、不隐藏计数。
  // 放在最前面短路,凌驾于所有其它判定(含 bbs_hidden)。
  if (m?.extra?.bbs_omit) return false;
  return isRealAiReply(m);
}

/**
 * 是否「真实的 AI 回复楼」——只看消息本身的物理性质,**不看番外标记**。
 * 与 isAiFloor 的区别:番外楼仍是真实 AI 回复(isRealAiReply=true),只是被引擎排除(isAiFloor=false)。
 * 楼内锚点要挂在所有真实 AI 回复上(含已标番外者,否则无从取消番外),故用它而非 isAiFloor。
 */
export function isRealAiReply(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.extra?.bbs_hidden) return true; // 被我们隐藏的旧 AI 楼
  // ST 原生系统楼带 extra.type(narrator/sys 等);真实回复(可见或被 /hide)无 type。
  if (m.is_system && m.extra?.type) return false;
  return true;
}

/**
 * 求「保留窗口」的起点索引:从这条消息起(含)都发全文,之前的可摘要/隐藏。
 * 对齐 Horae 的 _resolveAutoSummaryKeepStart——keepRecent 现在数的是 **AI 消息条数**。
 *   - 无 AI 楼 → 0(不隐藏)
 *   - keep<=0 → chat.length(全部可摘要)
 *   - AI 楼数 <= keep → 0(全保留)
 *   - 否则 → 倒数第 keep 个 AI 楼的索引
 */
export function resolveKeepStart(chat: STMessage[]): number {
  const keep = Math.max(0, apiSettings.keepRecent);
  const aiIdx: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (isAiFloor(chat[i])) aiIdx.push(i);
  }
  if (aiIdx.length === 0) return 0;
  if (keep <= 0) return chat.length;
  if (aiIdx.length <= keep) return 0;
  return aiIdx[aiIdx.length - keep];
}

/**
 * 找出"待摘要"的 AI 楼层:AI 楼且没有有效叶子(无叶 / 陈旧)。由旧到新。
 * 新消息、regenerate 新 swipe、编辑过的楼,都因 leafValid=false 自然落入。
 */
export function pendingAiFloors(chat: STMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (isAiFloor(chat[i]) && !leafValid(chat[i])) out.push(i);
  }
  return out;
}

/**
 * 「洞」楼层:违反核心不变式「除最后一条 AI 外,其余 AI 楼都必须有有效摘要」的待摘 AI 楼。
 * = 末尾 AI 楼之前的所有待摘 AI 楼。末尾那条豁免——它刚定稿、本就还没摘,属正常待摘而非洞。
 *
 * 这是生成拦截的判据(见 handleGenerationIntercept)。注意:**不看保留窗口(keepRecent)**——
 * 窗口内的中间洞(如某楼摘要失败、或手动删了某楼摘要)同样破坏不变式,必须拦,
 * 否则后发的楼会在「前面缺摘」时照常生成,导致状态/计划注入错位(D2 注入位置假设了此不变式)。
 */
export function holesExceptLast(chat: STMessage[]): number[] {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) return [];
  return pendingAiFloors(chat).filter(i => i < lastAi);
}

// 提示楼正文里的固定句,既给用户看,也用作「末楼是否已是本提示楼」的去重哨兵
const BACKLOG_NOTICE_SENTINEL = '本次生成已拦截';

/**
 * 「开场白待摘」场景:最新 AI 楼是**全对话第一条 AI 楼(开场白)**、尚未摘要、且正文无时间标签。
 * 返回该开场白楼层索引;不匹配返回 -1。
 *
 * 为何要特判:开场白不是本插件提示词生成的(卡片预设),通常既无 <bbs_start>/<bbs_end> 标签、
 * 也还没摘要 —— 此刻没有任何时间锚点。若放任首次正文生成,主模型会自行编一个时间,而开场白摘要
 * 又会独立编另一个,两者对不上(用户实测的时间错乱)。解法:先摘开场白,把时间落进叶子,主模型
 * 生成时经 latestStoryTime 的「无标签→回退叶子时间」兜底 + 注入的当前时间,即以此为基准推进,同步。
 * 开场白已带时间标签时不特判(主模型能直接读标签,有锚点),不必多等一次请求。
 */
export function openingPendingFloor(chat: STMessage[]): number {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) { lastAi = i; break; }
  }
  if (lastAi < 0) return -1;
  for (let i = lastAi - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) return -1; // 之前还有别的 AI 楼 → 不是开场白
  }
  if (leafValid(chat[lastAi])) return -1; // 已摘 → 锚点已在
  const tag = parseTimeRange(clampToTimeTags(chat[lastAi].mes));
  if (tag.start && tag.end) return -1; // 开场白自带时间标签 → 主模型能读,不必先摘
  return lastAi;
}

/**
 * 生成拦截器:每次「产出新正文」的生成前,守住不变式「除最后一条 AI 外其余都必须有摘要」。
 * 判据 = holesExceptLast(末尾 AI 之前的待摘楼层),按数量分流:
 *  - 0 个 → 放行。
 *  - 恰好 1 个 → 看那唯一的洞是否正在后台生成摘要(currentRun 非空):
 *      · 在飞 → toast 提示并 await 它结束(promise 永不 reject,不会卡死);完成后重判,洞填上则放行,否则拦截。
 *      · 不在飞 → 直接拦截(后台没在补它,等也没意义)。
 *  - >1 个 → 直接拦截(不等待;多个洞交给后台 maybeSummarizePrevAi「最早优先」逐条补,用户补完再重发)。
 * 拦截 = abort(true) + /sendas 插提示楼。
 *
 * 关键时序/口径(改前务必理解,否则极易复发并行 bug):
 *  1) type 口径必须与摘要触发(bindEngine 里 GENERATION_STARTED 监听器)一致——都放行
 *     continue/quiet/impersonate、都管 normal/regenerate/swipe。否则重生/翻页时「补摘」与「生成」会并行。
 *  2) GENERATION_STARTED(触发 maybeSummarizePrevAi)在 ST 中先于本拦截器 emit,且 maybeSummarizePrevAi
 *     到 runSummary 之间是同步代码、runSummary 同步置好 currentRun → 本拦截器跑时已能读到「在飞」信号。
 *  3) ST 会 await 本拦截器(script.js runGenerationInterceptors),故 await 能真正阻塞生成;
 *     且拦截器在 prompt 组装之前跑,摘要落盘后,后续组装阶段的注入自然带上新数据。
 * 跟随「自动摘要」开关:关了则一并不拦。
 */
export async function handleGenerationIntercept(
  type: string | undefined,
  abort: (immediately: boolean) => void,
): Promise<boolean> {
  if (!engineActiveHere()) return false; // 排除角色/总开关关:不拦
  if (!apiSettings.autoSummaryEnabled) return false; // 自动摘要关 → 拦截一并关
  // 要产出新正文的生成才拦:normal(发消息)/regenerate(重新生成)/swipe(翻页)。
  // 与摘要触发(GENERATION_STARTED 监听器)同口径,否则重生/翻页时「补摘」与「生成」会并行。
  // continue(续写)/quiet(安静)/impersonate(扮演)放行,不该被洞挡。
  if (type === 'continue' || type === 'quiet' || type === 'impersonate') return false;

  const ctx = getContext();
  if (!ctx) return false;
  if (!ctx.getCurrentChatId?.()) return false; // 欢迎页:无聊天不拦
  const chat = ctx.chat ?? [];

  // 开场白特判(不拦,只等):开场白无时间标签、又还没摘时,先摘它建立时间锚点,再放行首次生成。
  // 否则主模型与开场白摘要会各自凭空编一个开场时间,导致正文与摘要时间对不上(用户实测)。
  // 摘完(或失败退化)即继续放行——开场白摘要失败不该挡住用户开始游戏。
  const opening = openingPendingFloor(chat);
  if (opening >= 0) {
    const inflight = currentSummaryPromise();
    if (inflight) {
      toast('正在为开场白建立时间锚点,请稍候…', 'info');
      await inflight; // promise 永不 reject,不会卡死生成
    } else if (!busy) {
      toast('正在为开场白建立时间锚点,请稍候…', 'info');
      await runSummary(opening);
    }
    // 摘要落盘后 refreshInjection 已把「当前时间」刷成开场白时间;继续走洞判定(通常放行)。
  }

  let holes = holesExceptLast(chat);
  if (holes.length < 1) return false; // 无洞:放行

  // 恰好 1 个洞,且它正在后台生成 → 等它,等完重判(成功放行 / 失败落到拦截)。
  if (holes.length === 1) {
    const inflight = currentSummaryPromise();
    if (inflight) {
      toast('正在补摘前一楼层,请稍候…', 'info');
      await inflight;
      holes = holesExceptLast(chat);
      if (holes.length < 1) return false; // 补完,洞没了 → 放行
    }
  }

  abort(true); // 仍有洞(>1,或那唯一的洞没在飞/补失败):立即中止

  // 去重:末楼已是本提示楼就不再重复插(连点发送不刷屏)
  const last = chat[chat.length - 1];
  if (last && !last.is_user && typeof last.mes === 'string' && last.mes.includes(BACKLOG_NOTICE_SENTINEL)) {
    return true;
  }

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    // 多行靠 {{newline}} 宏(sendMessageAs 走 substituteParams 会还原成换行)
    const text = [
      `【柏宝书】${BACKLOG_NOTICE_SENTINEL}`,
      `发生了什么: 因为前面有楼层没有摘要，为了保证剧情的连续性，所以你需要先去给它补全摘要才能继续发送消息`,
      `应该怎么做: 点开左下角魔法棒，打开柏宝书界面，在第一页中，会显示“未摘要楼层”，点一下楼层号，就可以自动补全`,
      `补全失败: 多半是API问题，多尝试不同的API`,
      `补全成功: 在补全成功后，只需要把这一层提示楼层删掉，就可以继续正常生成了`
    ].join('{{newline}}');
    try {
      await exec(`/sendas name="柏宝书" ${text}`);
    } catch (e) {
      engineState.lastError = `积压提示楼插入失败: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return true;
}

/** 摘要后的统一收尾:同步滑动隐藏 + 刷新注入(自动隐藏已并入摘要流程,不再有独立开关) */
async function afterSummaryHideAndInject(chat: STMessage[]): Promise<void> {
  await syncWindowHiddenState(chat);
  refreshInjection();
}

/**
 * 对外的「检测一次隐藏」:按当前叶子覆盖情况同步滑动窗口隐藏 + 刷新注入。
 * 供迁移等批量写入叶子后调用,复用摘要收尾同一套逻辑;守卫与摘要流程一致
 * (引擎在此聊天不生效 / 自动摘要关闭则不隐藏,仅刷新注入)。
 */
export async function syncHiddenNow(): Promise<void> {
  const chat = getContext()?.chat ?? [];
  if (engineActiveHere() && apiSettings.autoSummaryEnabled) {
    await afterSummaryHideAndInject(chat);
  } else {
    refreshInjection();
  }
}

/**
 * 全量补摘:给所有「无有效叶子」的 AI 楼逐个生成摘要。
 * **仅供摘要页「立即摘要」按钮手动调用**——自动触发改用 maybeSummarizePrevAi(单楼增量)。
 */
export async function checkAutoSummary(): Promise<void> {
  console.log('[柏宝书] checkAutoSummary(手动全量) 进入', { enabled: apiSettings.autoSummaryEnabled, busy });
  if (!engineActiveHere()) { console.log('[柏宝书] 早退:插件总开关关闭或当前角色被排除'); return; }
  if (!apiSettings.autoSummaryEnabled) { console.log('[柏宝书] 早退:自动摘要未开启'); return; }
  if (busy) { console.log('[柏宝书] 早退:busy 锁'); return; }

  const ctx = getContext();
  if (!ctx) { console.log('[柏宝书] 早退:无 ctx'); return; }
  const chat = ctx.chat ?? [];
  if (chat.length === 0) { console.log('[柏宝书] 早退:chat 为空'); return; }

  const floors = pendingAiFloors(chat);
  console.log('[柏宝书] 待摘要楼层 =', floors);
  for (const floor of floors) {
    await runSummary(floor);
  }
  await afterSummaryHideAndInject(chat);
}

/**
 * 手动对单个楼层补摘(摘要页「未摘要楼层」列表逐楼点击)。
 * 与自动触发解耦:不看 autoSummaryEnabled,只要总开关开着就执行;摘完跑收尾(隐藏+注入)。
 */
export async function summarizeFloor(floor: number): Promise<void> {
  if (!engineActiveHere()) return;
  if (busy) return;
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (!isAiFloor(chat[floor]) || leafValid(chat[floor])) return;
  await runSummary(floor);
  await afterSummaryHideAndInject(chat);
}

/**
 * 标记 / 取消标记某楼为「番外」(小剧场/番外篇,与主线剧情无关)。
 * 番外楼对引擎**彻底不存在**:不摘、不总结、不重放派生、不注入——由 isAiFloor 等处的 bbs_omit 守卫实现。
 *
 * 非破坏性:只切 extra.bbs_omit 标记,**不删该楼已有的叶子**。故可逆——取消番外即刻恢复其摘要,
 * 无需重新调 AI。叶子/森林数据都原样保留,守卫只是在遍历时跳过它。
 *
 * ⚠️ 边界:若该楼的叶子**已被压进上层总结节点**(L1+),其叙事文字已融入 AI 写的总结散文里,
 * 无法无损抠除——那段总结文本仍含此楼,直到重新总结。绝大多数场景(小剧场刚写完就标番外、
 * 尚未压缩)不受影响,完全排除。
 *
 * @param on true=标为番外,false=取消番外
 */
export async function setFloorOmit(floor: number, on: boolean): Promise<void> {
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  const m = chat[floor];
  if (!m) return;
  const already = !!m.extra?.bbs_omit;
  if (already === on) return; // 幂等

  if (on) {
    m.extra = { ...(m.extra ?? {}), bbs_omit: true };
  } else {
    const { bbs_omit: _omit, ...rest } = m.extra ?? {};
    m.extra = rest;
  }

  // 标记随 chat 文件持久化;派生/注入/隐藏窗口按新口径重算。
  recomputeDerived();
  await syncHiddenNow(); // 内部据 engineActiveHere/autoSummary 决定是否同步隐藏,并刷新注入
  scheduleLeafFlush();
}

/**
 * 自动触发的单楼增量摘要:**最早待摘优先**,一次只摘一条。
 * @param skipLastAi true 时跳过正在操作的末尾 AI 消息(翻页/重新生成场景),它不参与目标选取。
 *
 * 不变式:除最后一条 AI 外,其余 AI 楼都应有摘要。为此目标取「可摘范围内最早的待摘 AI 楼」,
 * 而非「上一条」——否则前面有失败楼(洞)时,新楼会越过它先摘,导致倒序(计划漏删等)。
 *  - 发消息:可摘范围 = 直到最后一条 AI 楼。skipLastAi=false。
 *  - 翻页/重新生成:末尾 AI 正在被改写,排除它,范围 = 直到之前那条 AI。skipLastAi=true。
 * 配合生成拦截(有洞且未补完前不放行),每轮补一条也不会让洞越积越多。
 */
export async function maybeSummarizePrevAi(skipLastAi: boolean): Promise<void> {
  if (!engineActiveHere()) return;
  if (!apiSettings.autoSummaryEnabled) return;
  if (busy) return;
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (chat.length === 0) return;

  // 可摘范围上界:发消息=最后一条 AI;翻页/重生=之前那条 AI(末尾易变,排除)。
  const ceiling = prevAiFloor(chat, skipLastAi);
  if (ceiling < 0) return;
  // 范围内最早的待摘 AI 楼(洞优先);没有则仅跑收尾(隐藏窗口可能变化)。
  const target = pendingAiFloors(chat).find(f => f <= ceiling);
  if (target === undefined) {
    await afterSummaryHideAndInject(chat);
    return;
  }
  await runSummary(target);
  await afterSummaryHideAndInject(chat);
}

/**
 * 找「上一条已定稿 AI 消息」的索引。
 * skipLastAi=false → 最后一条 AI 楼;skipLastAi=true → 跳过最后一条 AI 楼,取再之前那条。
 * 找不到返回 -1。
 */
export function prevAiFloor(chat: STMessage[], skipLastAi: boolean): number {
  let lastAi = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) {
      lastAi = i;
      break;
    }
  }
  if (lastAi < 0) return -1;
  if (!skipLastAi) return lastAi;
  for (let i = lastAi - 1; i >= 0; i--) {
    if (isAiFloor(chat[i])) return i;
  }
  return -1;
}

/** 把递增的索引列表合并成连续区间(供 /hide 0-3 这种批量参数用) */
export function coalesceRanges(indices: number[]): Array<[number, number]> {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const ranges: Array<[number, number]> = [];
  for (const i of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && i === last[1] + 1) last[1] = i;
    else ranges.push([i, i]);
  }
  return ranges;
}

/**
 * 同步滑动窗口隐藏状态:
 *  - 隐藏「保留窗口之前、已被摘要覆盖、尚未隐藏」的消息。
 *  - 取消隐藏「曾由本插件隐藏、但现在不应隐藏」的消息。
 * 走 ST 原生 /hide(对齐 Horae、自动同步 DOM、走官方入口),
 * /unhide,同时用 extra.bbs_hidden 私有标记区分「我们隐藏的」与「ST 原生系统楼」。
 * 只隐藏已被摘要覆盖的,绝不制造信息黑洞。
 */
async function syncWindowHiddenState(chat: STMessage[]): Promise<void> {
  const keepStart = resolveKeepStart(chat);
  const covered = coveredSet(chat);
  const ctx = getContext();
  if (!ctx) return;

  const toHide: number[] = [];
  const toUnhide: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    const shouldHide = i < keepStart && covered.has(i);
    if (shouldHide) {
      if (!m.extra?.bbs_hidden || m.is_system !== true) toHide.push(i);
    } else if (m.extra?.bbs_hidden) {
      toUnhide.push(i);
    }
  }
  if (toHide.length === 0 && toUnhide.length === 0) return;

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    for (const [start, end] of coalesceRanges(toUnhide)) {
      const arg = start === end ? `${start}` : `${start}-${end}`;
      try {
        for (let i = start; i <= end; i++) {
          const m = chat[i];
          if (!m?.extra?.bbs_hidden) continue;
          const { bbs_hidden: _hidden, ...extra } = m.extra;
          m.extra = extra;
        }
        await exec(`/unhide ${arg}`);
      } catch (e) {
        // /unhide 失败则回退到直接写 is_system,保证取消隐藏一定落地
        for (let i = start; i <= end; i++) {
          const m = chat[i];
          if (!m) continue;
          m.is_system = false;
          if (m.extra?.bbs_hidden) {
            const { bbs_hidden: _hidden, ...extra } = m.extra;
            m.extra = extra;
          }
        }
        engineState.lastError = `/unhide ${arg} 失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    for (const [start, end] of coalesceRanges(toHide)) {
      const arg = start === end ? `${start}` : `${start}-${end}`;
      try {
        // 预写私有标记 + 内存态,防止 /hide 异步期间的竞态 saveChat 覆盖
        for (let i = start; i <= end; i++) if (chat[i]) chat[i].extra = { ...(chat[i].extra ?? {}), bbs_hidden: true };
        await exec(`/hide ${arg}`);
      } catch (e) {
        // /hide 失败则回退到直接写 is_system,保证隐藏一定落地
        for (let i = start; i <= end; i++) if (chat[i]) chat[i].is_system = true;
        engineState.lastError = `/hide ${arg} 失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } else {
    // 无 slash 执行器(旧版/未就绪):回退直接写 is_system + 重载
    for (const i of toUnhide) {
      const m = chat[i];
      if (!m) continue;
      m.is_system = false;
      if (m.extra?.bbs_hidden) {
        const { bbs_hidden: _hidden, ...extra } = m.extra;
        m.extra = extra;
      }
    }
    for (const i of toHide) {
      const m = chat[i];
      if (!m) continue;
      m.extra = { ...(m.extra ?? {}), bbs_hidden: true };
      m.is_system = true;
    }
    try {
      await ctx.saveChat();
      await ctx.reloadCurrentChat();
    } catch {
      /* 刷新失败不致命 */
    }
  }
}

/**
 * 对单个 AI 楼层执行摘要。
 * 上下文:为了让摘要连贯,把该 AI 楼层连同它前面紧邻的、尚未覆盖的用户发言一起喂给模型,
 * 但只把这一个 AI 楼层(及其前置用户楼层)标记为已覆盖。
 */
/**
 * 解析某摘要任务实际怎么发请求:
 *  - 指派了副 API 渠道 → 用该渠道(requestCompletion);
 *  - 未指派(空)→ 跟随主 API(requestViaMainApi → generateRaw,用主界面当前在用的 API,不带聊天历史)。
 * 主 API 也不可用(ST 无 generateRaw)时返回 error,调用方据此早退并写 lastError。
 */
function resolveSender(
  task: TaskType,
): { send: (messages: ChatMsg[]) => Promise<string>; label: string } | { error: string } {
  const channel = getChannelForTask(task);
  if (channel) {
    return { send: messages => requestCompletion(channel, messages), label: `渠道「${channel.name}」(${channel.model})` };
  }
  if (!mainApiAvailable()) {
    return { error: '未指派副 API 渠道,且当前主 API 不可用(请填好主 API 后重试,或为本任务单独指派渠道)' };
  }
  return { send: messages => requestViaMainApi(messages), label: '主 API(主界面当前在用)' };
}

/**
 * 发请求并解析,失败自动重试。失败 = 请求抛错 或 解析函数抛错(JSON 无效/缺字段)。
 * 最多重试 apiSettings.summaryMaxRetries 次(默认 1),即「首试 + N 次重试」共 N+1 次尝试。
 * 全部失败则抛出最后一次的错误,由调用方写 lastError。
 */
async function sendAndParse<T>(
  send: (messages: ChatMsg[]) => Promise<string>,
  messages: ChatMsg[],
  parse: (raw: string) => T,
): Promise<T> {
  const maxRetries = Math.max(0, apiSettings.summaryMaxRetries | 0);
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return parse(await send(messages));
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetries) {
        console.log(`[柏宝书] 第 ${attempt + 1} 次尝试失败,重试:`, e instanceof Error ? e.message : String(e));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * 单楼摘要。对外包一层,维护「当前在飞摘要」信号 currentRun,供生成拦截器 await(见 handleGenerationIntercept)。
 *  - currentRun 同步置为本次 promise → 拦截器在 GENERATION_STARTED(触发摘要)之后跑时已能读到它。
 *  - finally 里清回 null(只清自己,避免清掉后一次调用设的新 promise)。
 *  - 真正的请求/落盘在 runSummaryInner;它内部已 try/catch,promise 永不 reject → 拦截器 await 不会卡死。
 * 注:早退(busy/非 AI 楼等)也会经历「置 p → 立即 finally 清回 null」,只是 p 几乎瞬间 resolve,不构成有效在飞。
 */
export function runSummary(aiFloor: number): Promise<void> {
  const p = runSummaryInner(aiFloor).finally(() => {
    if (currentRun === p) currentRun = null;
  });
  currentRun = p;
  return p;
}

/**
 * 求某 AI 楼的「覆盖范围」(喂模型的上下文楼段):本 AI 楼 + 它前面紧邻的、尚未覆盖的(用户)楼层。
 * 碰到已覆盖楼或上一个 AI 楼即停。单楼与批量共用,保证两路径喂给模型的正文段一致。
 */
function floorTargets(chat: STMessage[], aiFloor: number, covered: Set<number>): number[] {
  const targets: number[] = [aiFloor];
  for (let i = aiFloor - 1; i >= 0; i--) {
    if (covered.has(i)) break;
    if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不把它正文并进摘要上下文(但不作屏障)
    if (isAiFloor(chat[i])) break; // 碰到上一个 AI 楼层就停
    if (chat[i]) targets.unshift(i);
  }
  return targets;
}

/**
 * 把一份 AI delta 固化成叶子并落到某 AI 楼(单楼与批量共用,保证两路径落叶口径一致)。
 *  - 时间:优先读该楼正文 <bbs_start>/<bbs_end> 标签(权威锚点);缺的那端用 AI 补的兜底。
 *  - plans.resolve 短序号 → 稳定 id:用传入的 stateBefore(本楼之前状态)的未了结计划顺序翻译。
 *  - 物品净变动写进正文 <bbs_items> 旁注(基准 = stateBefore.items)。
 * 不做 recompute/flush/注入——由调用方在合适时机统一收尾(批量可攒到块尾一次刷新)。
 */
function applyLeafForFloor(
  chat: STMessage[],
  aiFloor: number,
  delta: SummaryDelta,
  stateBefore: ReturnType<typeof deriveMemory>,
): void {
  // 时间锚点:从该楼正文标签读起止(先裁剪到正文段,跳过思维链/状态栏里混入的同名标签)
  const tag = parseTimeRange(clampToTimeTags(chat[aiFloor].mes));

  // 未了结计划的有序列表:顺序即提示词里的 p1/p2…,用于把 resolve 短序号翻译成稳定 id
  const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
  const storedDelta = finalizeDelta(delta, openPlansOrdered);

  // 时间起止:标签优先(与新剧情同源不漂移);标签缺的那端用 AI 补的 timeStart/timeEnd 兜底。
  const timeStart = tag.start || delta.timeStart?.trim() || undefined;
  const timeEnd = tag.end || delta.timeEnd?.trim() || delta.time?.trim() || undefined;
  // 状态当前时间(覆盖型):用结束时间(本段最后时刻);取不到则保留既有状态。
  if (timeEnd) storedDelta.time = timeEnd;

  const leaf: LeafExtra = {
    id: makeLeafId(),
    text: (delta.summary ?? '').trim(),
    delta: storedDelta,
    timeStart,
    timeEnd,
    createdAt: Date.now(),
    // 记录生成时所在页码,供 leafValid 判定归属(翻到别页时不串扰);缺 swipe_id 按第一页 0
    swipe: typeof chat[aiFloor].swipe_id === 'number' ? chat[aiFloor].swipe_id : 0,
    v: 1,
  };
  chat[aiFloor].extra = { ...(chat[aiFloor].extra ?? {}), bbs_leaf: leaf };

  // 把本楼物品净变动写进正文 </bbs_end> 之后(<bbs_items> 旁注,正则隐藏、不进副API摘要)。
  // 用 stateBefore.items(本楼之前的物品)作基准算 from→to;无变动则只清旧块。
  const changes = itemChangesOf(storedDelta, stateBefore.items, timeEnd || timeStart || '');
  let mes = writeItemLogTag(chat[aiFloor].mes, fmtItemLogInline(changes));
  // 自定义变量净变动同样写进正文 <bbs_vars>(紧随物品块,正则隐藏、不进副API摘要),
  // 让窗口内全文楼层的主模型看到「本楼已改过这些变量」,防重复改(与物品旁注同机制)。
  mes = writeVarLogTag(mes, fmtVarOpsInline(storedDelta.varOps));
  setMessageText(chat[aiFloor], mes);
}

/**
 * 单楼摘要的「纯工作」部分:发请求 + 解析 + 落叶 + 刷新派生/注入。
 * **不管理 busy / 不做守卫 / 不触发 checkResummary**——由调用方(runSummaryInner 或批量回退)负责。
 * 失败(请求报错 / JSON 无效)直接抛出,调用方决定如何处理。
 */
async function summarizeFloorWork(
  chat: STMessage[],
  aiFloor: number,
  sender: { send: (messages: ChatMsg[]) => Promise<string>; label: string },
): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('无 ST 上下文');

  const covered = coveredSet(chat);
  const targets = floorTargets(chat, aiFloor, covered);
  const content = renderMessages(chat, targets, ctx.name1, ctx.name2);

  // 两端标签齐才算「有标签」,提示词据此免去 AI 算时间。
  const tag = parseTimeRange(clampToTimeTags(chat[aiFloor].mes));
  const hasTimeTags = !!(tag.start && tag.end);

  // 截止到「被分析楼段之前」的状态与历史(不泄漏未来:重摘早期楼时排除其后叶子)
  const beforeIndex = targets[0];
  const stateBefore = deriveMemory(chat, beforeIndex);
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, beforeIndex));

  const worldInfo = await fetchWorldInfo(chat, targets, ctx.name1, ctx.name2);
  const charCard = fetchCharCard();
  const persona = fetchUserPersona();

  const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
  const prompt = buildSummaryPrompt({
    user: ctx.name1,
    char: ctx.name2,
    time: stateBefore.state.time,
    location: stateBefore.state.location,
    items: stateBefore.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })),
    itemLog: stateBefore.itemLog,
    scenes: stateBefore.scenes.map(s => ({ path: s.path, desc: s.desc })),
    npcs: stateBefore.npcs.map(n => ({ name: n.name, gender: n.gender, title: n.title, important: n.important, outfit: n.outfit, condition: n.condition, follow: n.follow, location: n.location })),
    openPlans: openPlansOrdered.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })),
    // 近期已完成计划:与注入端同口径,截止点用本楼之前的状态(不泄漏未来)
    resolvedPlans: selectRecentResolvedPlans(stateBefore.plans, apiSettings.recentResolvedPlansCount),
    history,
    content,
    hasTimeTags,
    // 自定义变量:当前状态取本楼之前(不泄漏未来);含义+规则各合并三层(副API两段都要)
    varsState: stateBefore.vars,
    varsMeaning: (['global', 'char', 'chat'] as const).map(t => memory.varTemplates[t].meaning.trim()).filter(Boolean).join('\n\n'),
    varsRule: (['global', 'char', 'chat'] as const).map(t => memory.varTemplates[t].rule.trim()).filter(Boolean).join('\n\n'),
  });

  const messages: ChatMsg[] = [];
  const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
  if (jb) messages.push({ role: 'system', content: jb });
  if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
  if (persona) messages.push({ role: 'system', content: buildPersonaSystem(persona) });
  if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
  messages.push(
    { role: 'user', content: prompt },
    { role: 'system', content: THINKING_CHECKLIST },
    { role: 'assistant', content: THINKING_PREFILL },
  );
  const delta = await sendAndParse(sender.send, messages, raw => {
    console.log('[柏宝书] 摘要原始返回(未清洗):\n', raw);
    const d = extractJsonObject<SummaryDelta>(raw);
    if (!d || !d.summary) {
      throw new Error(raw.trim() ? '摘要失败:AI道歉或掉格式' : '摘要失败:AI空回');
    }
    return d as SummaryDelta & { summary: string };
  });

  applyLeafForFloor(chat, aiFloor, delta, stateBefore);
  engineState.lastRunAt = Date.now();

  // 立刻反映到派生与注入;落盘走防抖(隐藏由收尾的 syncWindowHiddenState 统一负责)
  recomputeDerived();
  refreshInjection();
  scheduleLeafFlush();
  scheduleVectorIndex(); // 新叶子 → 防抖同步进向量库(失败静默,不影响摘要)
}

async function runSummaryInner(aiFloor: number): Promise<void> {
  console.log('[柏宝书] runSummary 楼层', aiFloor, '| busy =', busy);
  if (!engineActiveHere()) { console.log('[柏宝书] runSummary 早退:插件总开关关闭或当前角色被排除'); return; }
  if (busy) { console.log('[柏宝书] runSummary 早退:busy'); return; }
  const sender = resolveSender('summary');
  if ('error' in sender) {
    engineState.lastError = sender.error;
    console.log('[柏宝书] runSummary 早退:', sender.error);
    return;
  }
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (!isAiFloor(chat[aiFloor])) { console.log('[柏宝书] runSummary 早退:非 AI 楼', aiFloor); return; }
  console.log('[柏宝书] runSummary 即将发请求,', sender.label);

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    await summarizeFloorWork(chat, aiFloor, sender);
    // 摘要积累到阈值则触发总结
    await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
  }
}

/* ============ 批量补摘(分块批量,一次请求 → 多片单楼叶子) ============ */

/** 批量补摘选项 */
export interface BatchBackfillOpts {
  /** 待补摘的 AI 楼层(由旧到新);省略则取当前所有待摘 AI 楼 */
  floors?: number[];
}

/** 批量结果汇总 */
export interface BatchBackfillResult {
  /** 成功落叶的楼数 */
  done: number;
  /** 计划处理的总楼数 */
  total: number;
  /** 是否因取消提前结束 */
  cancelled: boolean;
}

/**
 * 按内容量把待摘楼层切成多个块:每块正文累计字符到 maxChars 或楼数到 maxFloors 即切。
 * 单楼正文超 maxChars 时自成一块(不可再分)。每块楼层升序,块间升序。
 * 字符量口径用 renderMessages(与喂模型同一清洗),只算该 AI 楼自身正文(够近似,省去重复算前置 user 楼)。
 */
export function planBatches(chat: STMessage[], floors: number[], maxChars: number, maxFloors: number): number[][] {
  const ctx = getContext();
  const name1 = ctx?.name1 ?? '';
  const name2 = ctx?.name2 ?? '';
  const lo = Math.max(1, maxFloors | 0);
  const cap = Math.max(500, maxChars | 0);

  const batches: number[][] = [];
  let cur: number[] = [];
  let curChars = 0;
  for (const f of floors) {
    const len = renderMessages(chat, [f], name1, name2).length;
    // 当前块非空,且(加这楼会超字数 或 楼数已达上限)→ 先切块
    if (cur.length && (curChars + len > cap || cur.length >= lo)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(f);
    curChars += len;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/**
 * 对一个块发一次批量请求,解析出 floors 数组并**逐楼落叶**(块内顺序,后楼承接前楼状态)。
 * 校验 floors 长度 == 块楼数;不符则抛错(由调用方按重试/回退处理)。
 */
async function summarizeBatchWork(
  chat: STMessage[],
  block: number[],
  sender: { send: (messages: ChatMsg[]) => Promise<string>; label: string },
): Promise<void> {
  const ctx = getContext();
  if (!ctx) throw new Error('无 ST 上下文');
  const covered = coveredSet(chat);

  // 块开头之前的状态/历史/世界书(整块统一口径,只取一次)
  const beforeIndex = floorTargets(chat, block[0], covered)[0];
  const stateBefore = deriveMemory(chat, beforeIndex);
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, beforeIndex));

  // 多楼正文:每楼带「━━ 第 n 楼 ━━」分隔,内含该 AI 楼 + 其前置未覆盖 user 楼
  const allTargets: number[] = [];
  const segments: string[] = [];
  block.forEach((f, idx) => {
    const targets = floorTargets(chat, f, covered);
    allTargets.push(...targets);
    segments.push(`━━ 第 ${idx + 1} 楼 ━━\n${renderMessages(chat, targets, ctx.name1, ctx.name2)}`);
  });
  const content = segments.join('\n\n');

  // 世界书按整块合并正文激活一次(省去逐楼激活)
  const worldInfo = await fetchWorldInfo(chat, allTargets, ctx.name1, ctx.name2);
  const charCard = fetchCharCard();
  const persona = fetchUserPersona();

  const prompt = buildBatchSummaryPrompt({
    user: ctx.name1,
    char: ctx.name2,
    time: stateBefore.state.time,
    location: stateBefore.state.location,
    history,
    content,
    floorCount: block.length,
  });

  const { checklist, prefill } = buildBatchThinking(block.length);
  const messages: ChatMsg[] = [];
  const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
  if (jb) messages.push({ role: 'system', content: jb });
  if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
  if (persona) messages.push({ role: 'system', content: buildPersonaSystem(persona) });
  if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
  messages.push(
    { role: 'user', content: prompt },
    { role: 'system', content: checklist },
    { role: 'assistant', content: prefill },
  );

  // 解析 { floors: [...] };校验长度等于块楼数(缺楼/多楼都算失败,触发重试/回退)
  const list = await sendAndParse(sender.send, messages, raw => {
    console.log('[柏宝书] 批量摘要原始返回(未清洗):\n', raw);
    const d = extractJsonObject<{ floors?: SummaryDelta[] }>(raw);
    const floors = d?.floors;
    if (!Array.isArray(floors) || !floors.length) {
      throw new Error(raw.trim() ? '批量摘要失败:AI道歉或掉格式' : '批量摘要失败:AI空回');
    }
    if (floors.length !== block.length) {
      throw new Error(`批量摘要失败:返回 ${floors.length} 楼,期望 ${block.length} 楼`);
    }
    if (floors.some(f => !f || !f.summary)) {
      throw new Error('批量摘要失败:有楼层缺 summary');
    }
    return floors;
  });

  // 逐楼落叶(块内顺序,严格按 block 升序)。批量只取 summary + 起止时间:
  // 显式剥掉 items/plans/location —— 这些跨多楼难保顺序正确(易致计划/时间错乱),
  // 即便 AI 不听话硬产了也丢弃。结构化数据交给后续正常的逐楼自动摘要。
  block.forEach((f, idx) => {
    const r = list[idx];
    const lean: SummaryDelta = {
      summary: r.summary,
      timeStart: r.timeStart,
      timeEnd: r.timeEnd,
    };
    const sb = deriveMemory(chat, f);
    applyLeafForFloor(chat, f, lean, sb);
  });

  engineState.lastRunAt = Date.now();
  recomputeDerived();
  refreshInjection();
  scheduleLeafFlush();
  scheduleVectorIndex();
}

/**
 * 批量补摘:把待摘 AI 楼按内容量切块,逐块串行发请求、**严格按楼序逐楼落叶**。
 * 省 token 关键:固定上下文(破限/设定/前情)按块分摊,而非每楼重发。
 *  - 批量只产 summary + 起止时间(不产物品/计划),避免跨多楼的结构化数据顺序错乱;
 *    结构化数据交给后续正常的逐楼自动摘要补。
 *  - 块间串行 + 块内 AI 顺序维护时间单调,后块用前块落盘后的前情。
 *  - 某块解析失败(已含 summaryMaxRetries 次重试)→ 回退:对该块逐楼走单楼摘要(单楼路径仍产完整结构化数据),不中断整体。
 *  - 取消在块边界生效(不打断进行中的块)。
 * 全部完成后触发 checkResummary(连锁 L1/L2)+ 收尾(隐藏 + 注入)。
 */
export async function batchBackfill(opts: BatchBackfillOpts = {}): Promise<BatchBackfillResult> {
  if (!engineActiveHere()) return { done: 0, total: 0, cancelled: false };
  if (busy) return { done: 0, total: 0, cancelled: false };
  const sender = resolveSender('summary');
  if ('error' in sender) {
    engineState.lastError = sender.error;
    return { done: 0, total: 0, cancelled: false };
  }
  const ctx = getContext();
  if (!ctx) return { done: 0, total: 0, cancelled: false };
  const chat = ctx.chat ?? [];

  // 目标楼层:显式传入则过滤成「当前确实待摘的 AI 楼」(防陈旧),否则取全部待摘
  const pending = new Set(pendingAiFloors(chat));
  const floors = (opts.floors ?? [...pending]).filter(f => pending.has(f)).sort((a, b) => a - b);
  const total = floors.length;
  if (total === 0) {
    await afterSummaryHideAndInject(chat);
    return { done: 0, total: 0, cancelled: false };
  }

  const batches = planBatches(chat, floors, apiSettings.batchMaxChars, apiSettings.batchMaxFloors);
  console.log('[柏宝书] 批量补摘:', total, '楼 →', batches.length, '批,', sender.label);

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  // 批量状态(模块级单例)→ UI 跨关窗重开可恢复进度/取消
  batchState.running = true;
  batchState.cancelRequested = false;
  batchState.done = 0;
  batchState.total = total;
  let done = 0;
  let cancelled = false;
  try {
    for (const block of batches) {
      if (batchState.cancelRequested) { cancelled = true; break; }
      try {
        await summarizeBatchWork(chat, block, sender);
      } catch (e) {
        // 整块失败(已含重试)→ 回退:逐楼单独摘。单楼也可能失败(写 lastError),失败楼留作待摘,不中断后续。
        console.log('[柏宝书] 批量块失败,回退逐楼:', e instanceof Error ? e.message : String(e));
        for (const f of block) {
          if (!isAiFloor(chat[f]) || leafValid(chat[f])) continue; // 已被填或非 AI 楼:跳过
          try {
            await summarizeFloorWork(chat, f, sender);
          } catch (e2) {
            engineState.lastError = e2 instanceof Error ? e2.message : String(e2);
          }
        }
      }
      // 本块产出的已落叶楼计入进度(只数确实落上叶子的,失败楼不计)
      done = floors.filter(f => leafValid(chat[f])).length;
      batchState.done = done;
    }
    // 连锁触发总结(可能跨多层),失败写 lastError 不影响已落叶子
    await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
    batchState.running = false;
    batchState.cancelRequested = false;
  }
  await afterSummaryHideAndInject(chat);
  return { done, total, cancelled };
}

/**
 * 当前已被覆盖的楼层索引集合(几何即时推导,不读存储)。
 * 一条 AI 楼若有有效叶子 → 它及其前置「尚未被更早 AI 叶子覆盖」的楼(含 user 楼)都算被覆盖。
 * 即区间 (上一条有效 AI 叶子, 本条有效 AI 叶子] 全覆盖。待摘要 AI 楼不闭合区间。
 */
export function coveredSet(chat: STMessage[]): Set<number> {
  const covered = new Set<number>();
  let segStart = 0;
  for (let i = 0; i < chat.length; i++) {
    if (!isAiFloor(chat[i])) continue;
    if (leafValid(chat[i])) {
      for (let k = segStart; k <= i; k++) covered.add(k);
      segStart = i + 1;
    }
    // 待摘要 AI 楼(无有效叶子):段不前进,等它被摘后再覆盖
  }
  return covered;
}

/** 某层级触发压缩所需的阈值:叶子层用 leafBatchThreshold,其余用 resummaryThreshold */
function thresholdForLevel(level: number): number {
  return level === 0 ? apiSettings.leafBatchThreshold : apiSettings.resummaryThreshold;
}

/**
 * 把一批待融合节点拼成给总结模型的 content:**每段头部标注该段时间范围**。
 * 关键:摘要正文的权威时间存在 timeStart/timeEnd 字段(正文里常不含完整日期),
 * 若只喂正文,总结被「必须写满日期」的规则逼着现编 → 日期全对不上(已修的 bug)。
 * 故这里把真实时间随正文一并交给模型,让它「看着写」而非凭空造。
 * 时间括注:两端齐→「起 – 止」;只有一端→那一端;都无→不加括注(不硬造)。
 */
function joinNodesForResummary(nodes: Array<{ text: string; timeStart?: string; timeEnd?: string }>): string {
  return nodes
    .map((n, i) => {
      const start = n.timeStart?.trim();
      const end = n.timeEnd?.trim();
      let time = '';
      if (start && end) time = start === end ? `(${start}) ` : `(${start} – ${end}) `;
      else if (start || end) time = `(${start || end}) `;
      return `[${i + 1}] ${time}${n.text}`;
    })
    .join('\n\n');
}

/** 压缩用的根节点视图:带起止时间(叶子直接取,comp 取已聚合的范围),供向上合并时取边界。 */
interface RootView {
  id: string;
  text: string;
  createdAt: number;
  timeStart?: string;
  timeEnd?: string;
}

/** 某层级「未被收纳的根节点」,按时间/楼层升序。level0=叶子(扫 chat),level≥1=森林。 */
function rootsAtLevel(level: number, chat: STMessage[]): RootView[] {
  const collected = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds) collected.add(c);

  if (level === 0) {
    const out: RootView[] = [];
    for (let i = 0; i < chat.length; i++) {
      if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不进森林压缩
      if (!leafValid(chat[i])) continue;
      const lf = getLeaf(chat[i]) as LeafExtra;
      if (collected.has(lf.id)) continue; // 已被某 L1 收纳
      out.push({ id: lf.id, text: lf.text, createdAt: lf.createdAt, timeStart: lf.timeStart, timeEnd: lf.timeEnd }); // 已按楼层序
    }
    return out;
  }
  return memory.summaries
    .filter(s => s.level === level && !collected.has(s.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    .map(s => ({ id: s.id, text: s.text, createdAt: s.createdAt, timeStart: s.timeStart, timeEnd: s.timeEnd }));
}

/**
 * 可逆层级压缩(不删底层)。
 * 从最低层往上逐层检查:某层「未被收纳的根节点」攒够该层阈值时,
 * 用 AI 把这批的**叙事文本**融合成一条上层节点,childIds 收纳它们(底层全部保留)。
 * 一次调用会向上连锁(加叶子→可能生 L1→可能生 L2…),用同一套双阈值递归。
 */
export async function checkResummary(): Promise<number> {
  if (!engineActiveHere()) return 0;
  const ctx = getContext();
  if (!ctx) return 0;
  const chat = ctx.chat ?? [];

  let made = 0; // 本次连锁共生成的总结条数

  // 最高现存压缩层级,作为连锁上限(+1 容纳新生成的层)
  const maxLevel = memory.summaries.reduce((m, s) => Math.max(m, s.level), 0);

  for (let level = 0; level <= maxLevel + 1; level++) {
    const threshold = thresholdForLevel(level);
    if (!threshold || threshold < 2) continue;

    const roots = rootsAtLevel(level, chat);
    if (roots.length < threshold) continue;

    const sender = resolveSender('resummary');
    if ('error' in sender) {
      engineState.lastError = sender.error;
      return made;
    }

    const batch = roots.slice(0, threshold);
    const content = joinNodesForResummary(batch);
    // 传**输出层级**(level+1):L1(普通总结,300-500字)/ L2+(二次总结,字数随输入动态)
    const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content, level: level + 1 });

    try {
      const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
      const messages: ChatMsg[] = [];
      if (jb) messages.push({ role: 'system', content: jb });
      messages.push({ role: 'user', content: prompt });
      // 发请求 + 解析,失败按设置重试(请求报错或 JSON 无效/缺 summary 都算失败)
      const delta = await sendAndParse(sender.send, messages, raw => {
        console.log('[柏宝书] 总结原始返回(未清洗):\n', raw);
        const d = extractJsonObject<{ summary?: string }>(raw);
        if (!d?.summary) {
          // 输出层级 level+1:为 1 是普通总结,≥2 是二次总结;有文本=掉格式,空白=空回
          const what = level + 1 === 1 ? '总结' : '二次总结';
          throw new Error(raw.trim() ? `${what}失败:AI道歉或掉格式` : `${what}失败:AI空回`);
        }
        return d as { summary: string };
      });

      // 生成上层节点收纳这批(**不删 batch**),时间戳取批内最新,排在它们之后
      const newCreatedAt = Math.max(...batch.map(s => s.createdAt)) + 1;
      // 起止时间:batch 已按时间升序 → 首个有起始的作 start,末个有结束的作 end
      const timeStart = batch.find(s => s.timeStart)?.timeStart;
      const timeEnd = [...batch].reverse().find(s => s.timeEnd)?.timeEnd;
      addSummary({
        text: delta.summary.trim(),
        level: level + 1,
        childIds: batch.map(s => s.id),
        auto: true,
        createdAt: newCreatedAt,
        timeStart,
        timeEnd,
      });
      made += 1;
      refreshInjection();
      // 不 break:继续外层 for,上一层可能也攒够了 → 连锁压更高层
    } catch (e) {
      engineState.lastError = e instanceof Error ? e.message : String(e);
      return made; // 本层失败则停止连锁,下次再试
    }
  }
  return made;
}

/* ============ 手动强制总结(多选合并,无视阈值) ============ */

/** 一个可被合并的节点(叶子或压缩节点)在引擎里的统一视图。 */
interface SelectableNode {
  id: string;
  text: string;
  level: number; // 叶子=0,comp=其层级
  timeStart?: string;
  timeEnd?: string;
  floorLo: number; // 覆盖楼层下界(叶子=自身楼层;comp=后代叶子最小);无则 -1
  floorHi: number; // 覆盖楼层上界
}

/**
 * 解析当前森林里「所有节点」的统一视图 + 覆盖楼层。
 * 叶子来自 chat(有效叶子),楼层 = msgIndex;comp 来自 memory.summaries,楼层 = 递归后代叶子 min..max。
 * 供 summarizeSelected 排序、取时间范围、算覆盖范围。
 */
function collectSelectableNodes(chat: STMessage[]): Map<string, SelectableNode> {
  const map = new Map<string, SelectableNode>();
  // 叶子:id → 楼层
  const leafFloor = new Map<string, number>();
  for (let i = 0; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不作为可选节点
    if (!leafValid(chat[i])) continue;
    const lf = getLeaf(chat[i]) as LeafExtra;
    leafFloor.set(lf.id, i);
    map.set(lf.id, { id: lf.id, text: lf.text, level: 0, timeStart: lf.timeStart, timeEnd: lf.timeEnd, floorLo: i, floorHi: i });
  }
  // comp:递归解析后代叶子楼层
  const byComp = new Map(memory.summaries.map(s => [s.id, s]));
  const floorsOf = (id: string, seen: Set<string>, acc: number[]): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const lf = leafFloor.get(id);
    if (lf !== undefined) { acc.push(lf); return; }
    const c = byComp.get(id);
    if (!c) return;
    for (const cid of c.childIds ?? []) floorsOf(cid, seen, acc);
  };
  for (const s of memory.summaries) {
    const floors: number[] = [];
    floorsOf(s.id, new Set(), floors);
    const lo = floors.length ? Math.min(...floors) : -1;
    const hi = floors.length ? Math.max(...floors) : -1;
    map.set(s.id, { id: s.id, text: s.text, level: s.level, timeStart: s.timeStart, timeEnd: s.timeEnd, floorLo: lo, floorHi: hi });
  }
  return map;
}

/**
 * 手动强制总结:把用户勾选的若干**根节点**(叶子/总结混层)无视阈值合并成一条上层总结。
 * 与自动 checkResummary 的区别:不看阈值、不看层级是否齐整,直接压这一批。
 *  - level = max(选中层级) + 1;时间范围 = 排序后首个 timeStart + 末个 timeEnd(同 checkResummary)。
 *  - 连续性兜底:选中节点覆盖楼层需连成一段(UI 已限制,这里防御);跨层混选允许。
 *  - 生成节点 auto=false 标手动。busy 互斥,收尾同 resummarizeNow + 隐藏/注入。
 * 返回 { made, error }:made=1 成功,0 未生成(error 说明原因)。
 */
export async function summarizeSelected(nodeIds: string[]): Promise<{ made: number; error?: string }> {
  if (!engineActiveHere()) return { made: 0, error: '插件未在当前聊天生效' };
  if (busy) return { made: 0, error: '正忙,请稍后再试' };
  if (nodeIds.length < 2) return { made: 0, error: '至少选择两条才能合并' };

  const ctx = getContext();
  if (!ctx) return { made: 0, error: '无 ST 上下文' };
  const chat = ctx.chat ?? [];

  const all = collectSelectableNodes(chat);
  const picked: SelectableNode[] = [];
  for (const id of nodeIds) {
    const n = all.get(id);
    if (!n) return { made: 0, error: '有选中项已失效,请刷新后重试' };
    picked.push(n);
  }
  // 按覆盖楼层升序(与摘要森林时序一致);无楼层的排最后
  const key = (n: SelectableNode) => (n.floorLo < 0 ? Number.MAX_SAFE_INTEGER : n.floorLo);
  picked.sort((a, b) => key(a) - key(b));

  // 连续性兜底:选中项必须是「当前根序列」里的一段连续切片(中间不能跳过其它根)。
  // ⚠️ 不能用 msgIndex 差值(cur.floorLo > prev.floorHi + 1)判断——叶子的 floorLo/Hi 只记
  // 自身那条 AI 楼的 index,不含前置 user 楼,而相邻 AI 楼之间必然隔着 user 楼(差≥2),
  // 那样会把任意两条相邻叶子摘要误判为不连续(合并静默失败的根因)。改为按「根在森林里的次序」
  // 判断,与 UI 的 canMerge(根序列数组索引相邻)同源。
  const referenced = new Set<string>();
  for (const s of memory.summaries) for (const c of s.childIds ?? []) referenced.add(c);
  const rootOrder = [...all.values()].filter(n => !referenced.has(n.id)).sort((a, b) => key(a) - key(b));
  const posOf = new Map(rootOrder.map((n, i) => [n.id, i] as const));
  const positions: number[] = [];
  for (const n of picked) {
    const p = posOf.get(n.id);
    if (p === undefined) return { made: 0, error: '选中项里有已被收纳的摘要,请只选顶层摘要' };
    positions.push(p);
  }
  positions.sort((a, b) => a - b);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] !== positions[i - 1] + 1) {
      return { made: 0, error: '只能合并连续的摘要(中间不能跳过其它摘要)' };
    }
  }

  const sender = resolveSender('resummary');
  if ('error' in sender) return { made: 0, error: sender.error };

  const level = Math.max(...picked.map(n => n.level)) + 1;
  const content = joinNodesForResummary(picked);
  const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content, level });

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
    const messages: ChatMsg[] = [];
    if (jb) messages.push({ role: 'system', content: jb });
    messages.push({ role: 'user', content: prompt });
    const delta = await sendAndParse(sender.send, messages, raw => {
      console.log('[柏宝书] 强制总结原始返回(未清洗):\n', raw);
      const d = extractJsonObject<{ summary?: string }>(raw);
      if (!d?.summary) {
        const what = level === 1 ? '总结' : '二次总结';
        throw new Error(raw.trim() ? `${what}失败:AI道歉或掉格式` : `${what}失败:AI空回`);
      }
      return d as { summary: string };
    });

    // 时间范围:picked 已按楼层升序 → 首个有起始的作 start,末个有结束的作 end(同 checkResummary)
    const timeStart = picked.find(s => s.timeStart)?.timeStart;
    const timeEnd = [...picked].reverse().find(s => s.timeEnd)?.timeEnd;
    addSummary({
      text: delta.summary.trim(),
      level,
      childIds: picked.map(s => s.id),
      auto: false, // 手动合并
      timeStart,
      timeEnd,
    });
    engineState.lastRunAt = Date.now();
    recomputeDerived();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    engineState.lastError = msg;
    return { made: 0, error: msg };
  } finally {
    busy = false;
    engineState.running = false;
  }
  await afterSummaryHideAndInject(chat);
  return { made: 1 };
}

/**
 * 手动「立即检测并总结」:供摘要页按钮调用。
 * 与自动路径同一套阈值/连锁逻辑(checkResummary),但带 busy 互斥,
 * 避免与正在跑的摘要/总结撞车。返回新生成的总结条数(0 = 未达阈值,什么都没做)。
 */
export async function resummarizeNow(): Promise<number> {
  if (!engineActiveHere()) return 0;
  if (busy) return 0;
  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    return await checkResummary();
  } finally {
    busy = false;
    engineState.running = false;
  }
}

/**
 * 响应 chat 结构变动(翻页/删除/编辑):数据已随消息自动跟随,只需清坏链、重算派生、刷新,
 * 不做任何索引手术、**不触发摘要生成**(生成由 maybeSummarizePrevAi 按规则单独决定)。
 * debounce 合并快速连翻。
 */
let reactTimer: ReturnType<typeof setTimeout> | null = null;
function reactToChatMutation(syncHidden = false): void {
  if (reactTimer) clearTimeout(reactTimer);
  reactTimer = setTimeout(() => {
    reactTimer = null;
    pruneBrokenComps(); // 叶子失效 → 删包含它的整条祖先压缩链
    recomputeDerived(); // 删叶/陈旧 → 物品/计划回退;UI(derivedMeta)更新
    scheduleVectorIndex(); // 删楼/编辑/翻页 → 防抖对账向量库(删陈旧、补新)
    if (syncHidden && engineActiveHere() && apiSettings.autoSummaryEnabled) {
      void syncWindowHiddenState(getContext()?.chat ?? [])
        .catch(e => {
          engineState.lastError = e instanceof Error ? e.message : String(e);
        })
        .finally(() => refreshInjection());
      return;
    }
    refreshInjection(); // 不再注入陈旧/已删叶子
  }, 200);
}

/**
 * 绑定事件。摘要触发规则:**只确保「上一条已定稿 AI 消息」有摘要**(单楼增量,非全量)。
 * 进入聊天 / 翻到没摘要的页,都不再自动立刻补摘。
 *  - USER_MESSAGE_RENDERED:发新消息 → 摘「上一条 AI」(skipLastAi=false)。
 *  - GENERATION_STARTED(regenerate/swipe):末尾 AI 正在被改写,跳过它 → 摘「之前那条 AI」(skipLastAi=true)。
 *  - MESSAGE_SWIPED / MESSAGE_EDITED:数据随消息跟随 → reactToChatMutation(清坏链+重算+刷新),不在此处生成。
 *  - MESSAGE_DELETED:同上,并同步一次滑动隐藏/取消隐藏。
 *  - CHAT_CHANGED:store 负责重载,这里刷新注入。
 */
export function bindEngine(): void {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  const es = ctx.eventSource;
  const et = ctx.eventTypes;

  console.log('[柏宝书] bindEngine 执行,监听', et.USER_MESSAGE_RENDERED, et.GENERATION_STARTED);

  // 发新消息:此刻末尾 AI 是「上一条已定稿」的回复,摘它。
  es.on(et.USER_MESSAGE_RENDERED, () => {
    console.log('[柏宝书] USER_MESSAGE_RENDERED → 摘上一条 AI');
    void maybeSummarizePrevAi(false);
  });

  // 重新生成 / 翻页:GENERATION_STARTED 时末尾 AI 即将被改写(易变),跳过它,摘之前那条 AI。
  // ⚠️ 这里放行的 type(quiet/impersonate/continue)必须与 handleGenerationIntercept 第一道闸严格一致——
  //    两者口径一旦不同步,重生/翻页会出现「补摘」与「正文生成」并行(见拦截器注释的「关键时序/口径」)。
  if (et.GENERATION_STARTED) {
    es.on(et.GENERATION_STARTED, (type?: string, _opts?: unknown, dryRun?: boolean) => {
      if (dryRun) return;
      if (type === 'quiet' || type === 'impersonate' || type === 'continue') return; // 非真实新回复
      console.log('[柏宝书] GENERATION_STARTED → 摘上上条 AI, type =', type);
      void maybeSummarizePrevAi(true);
    });
  }

  // 以下三事件只让数据/UI 跟随,不主动生成摘要。
  if (et.MESSAGE_SWIPED) es.on(et.MESSAGE_SWIPED, () => reactToChatMutation());
  // 编辑消息:先把该楼正文里 <bbs_items> 旁注的改动反向同步回叶子 delta(用户手改物品),
  // 再走通用善后(清坏链/重算/刷新)。延迟一拍确保 ST 已把编辑写回 chat[messageId].mes。
  if (et.MESSAGE_EDITED) {
    es.on(et.MESSAGE_EDITED, (messageId?: number) => {
      setTimeout(() => {
        if (typeof messageId === 'number') {
          try { syncItemLogFromMessage(messageId); } catch (e) { console.warn('[柏宝书] 物品旁注反解析失败', e); }
        }
        reactToChatMutation();
      }, 0);
    });
  }
  if (et.MESSAGE_DELETED) es.on(et.MESSAGE_DELETED, () => reactToChatMutation(true));

  // AI 新回复落定:不一定会触发摘要(自动摘要关闭 / 它不是「上一条 AI」),
  // 但「未摘要楼层」列表必须跟上新增的 AI 楼,故无条件重算一次派生缓存(不发请求)。
  if (et.CHARACTER_MESSAGE_RENDERED) es.on(et.CHARACTER_MESSAGE_RENDERED, () => recomputeDerived());

  if (et.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, () => {
      // 记忆重载由 store 的 CHAT_CHANGED 监听负责;此处仅在其后刷新注入
      clearRecallInjection(); // 切聊天先抹掉上个聊天的召回残留(新聊天下次生成再重算)
      setTimeout(() => refreshInjection(), 0);
    });
  }

  // 总开关切换:关闭→清掉已注入的记忆槽(不动已隐藏楼层与已存摘要,符合「已有数据不处理」);
  // 开启→把当前记忆重新注入回上下文。仅响应切换,不在首帧触发。
  watch(
    () => apiSettings.enabled,
    on => (on ? refreshInjection() : clearInjection()),
  );

  // 自动摘要开关切换:时间标签(隐藏正则 + 固定提示词)随它启停,不再独立开关。
  watch(
    () => apiSettings.autoSummaryEnabled,
    () => {
      syncTimeTagRegex();
      refreshInjection();
    },
  );
}
