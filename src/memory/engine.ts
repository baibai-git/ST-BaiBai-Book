import type { ChatMsg } from '@/api/client';
import { mainApiAvailable, requestCompletion, requestViaMainApi } from '@/api/client';
import { apiSettings, engineActiveHere, getChannelForTask } from '@/api/settings';
import type { TaskType } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { toast } from '@/st/toast';
import { addSummary, deriveMemory, finalizeDelta, getLeaf, itemChangesOf, leafValid, makeLeafId, pruneBrokenComps, stripHtml, syncItemLogFromMessage } from './apply';
import { extractJsonObject } from './json';
import { clearInjection, refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { buildCharCardSystem, buildResummaryPrompt, buildSummaryPrompt, buildWorldInfoSystem, fmtItemLogInline, JAILBREAK_PROMPT, THINKING_CHECKLIST, THINKING_PREFILL } from './prompts';
import { clampToTimeTags, inlineTimeTags, parseTimeRange, syncTimeTagRegex, writeItemLogTag } from './timeTag';
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

let busy = false;
// 当前在飞的摘要完成信号:拦截器可 await 它(成功/失败都 resolve,永不 reject,故不会卡死生成)。
// 无在飞摘要时为 null。在 runSummary 头尾维护。
let currentRun: Promise<void> | null = null;
export function currentSummaryPromise(): Promise<void> | null {
  return currentRun;
}

/** 把消息渲染成给摘要模型的文本(stripHtml 复用 apply 的清洗,与 leafHash 一致) */
function renderMessages(chat: STMessage[], indices: number[], name1: string, name2: string): string {
  return indices
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      // 双标:既标发言方(用户/角色),又带人名 —— 摘要正文用人名,群聊也能区分谁说的
      const tag = m.is_user ? '用户' : '角色';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      // 处理顺序:先裁剪到 <bbs_start>…</bbs_end>(剔除状态栏等正文外格式)→
      // 再把时间标签转可读文本(否则 stripHtml 会连内部时间一起删)→ 最后清洗思维链/标签
      return `【${tag}·${who}】${stripHtml(inlineTimeTags(clampToTimeTags(m.mes)))}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * 按本轮待摘文本激活世界书条目(关键词触发 + constant 蓝灯),返回设定文本。
 * 走 ST 的 getWorldInfoPrompt(isDryRun=true,只扫描不触发副作用事件)。
 * 关键:蓝灯/相关条目可能落在 before、after、depth(@深度)、作者注 任一位置,全部提取,
 * 否则会漏掉大量「@深度」位置的蓝灯条目(只取 before/after 会拿到空)。
 * 取不到 API / 出错 / 无激活条目 / 角色卡无世界书 → 返回空串(降级,不影响摘要正常运行)。
 */
async function fetchWorldInfo(chat: STMessage[], targets: number[], name1: string, name2: string): Promise<string> {
  const ctx = getContext();
  const fn = ctx?.getWorldInfoPrompt;
  if (typeof fn !== 'function') return '';
  try {
    // 扫描文本:本轮各楼正文(清洗后)。用人名前缀帮助关键词命中角色名。
    const scanText = targets
      .map(i => {
        const m = chat[i];
        if (!m) return '';
        const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
        return `${who}: ${stripHtml(m.mes)}`;
      })
      .filter(Boolean);
    if (!scanText.length) return '';
    // ST 内部:WI 实际预算 = world_info_budget(默认25%) × maxContext,超出即截断条目(蓝灯也不例外)。
    // 摘要场景要「激活的一条都不漏」,故传一个极大的 maxContext,让预算大到不可能溢出。
    // (若用户设了 world_info_budget_cap 上限,仍会被它封顶——那是用户显式的硬上限,尊重之。)
    const HUGE_CONTEXT = 1_000_000_000;
    const res = await fn(scanText, HUGE_CONTEXT, true);
    if (!res) return '';

    const chunks: string[] = [];
    if (typeof res.worldInfoBefore === 'string') chunks.push(res.worldInfoBefore);
    if (typeof res.worldInfoAfter === 'string') chunks.push(res.worldInfoAfter);
    // @深度条目:{depth, role, entries: string[]} —— 大量蓝灯在此
    for (const d of res.worldInfoDepth ?? []) {
      for (const e of d?.entries ?? []) if (typeof e === 'string') chunks.push(e);
    }
    for (const e of res.anBefore ?? []) if (typeof e === 'string') chunks.push(e);
    for (const e of res.anAfter ?? []) if (typeof e === 'string') chunks.push(e);

    // 去重 + 去空
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of chunks) {
      const t = c.trim();
      if (t && !seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
    return out.join('\n\n').trim();
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
 * 是否「可追踪的 AI 楼层」。与「是否对主 LLM 可见」解耦——隐藏与否都要算,只要它是真实的 AI 回复。
 *
 * 关键区分:`is_system=true` 有两种来源,不能一概排除:
 *   ① 被隐藏的真实 AI 回复(我们 /hide 的 → 带 extra.bbs_hidden;或用户/别的扩展 /hide 的 → 无标记)
 *      —— 这些是角色的真实发言,**必须算 AI 楼**,否则隐藏过的楼就漏摘(用户实测痛点)。
 *   ② ST 原生系统楼(/sys、/comment、叙事注入等)—— 这些带 extra.type,**不算**。
 * 据此:非用户、有正文、且不是「带 type 的原生系统楼」即为 AI 楼。普通可见回复 is_system=false 自然命中。
 */
export function isAiFloor(m: STMessage | undefined): boolean {
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

  // 覆盖范围(喂模型的上下文):本 AI 楼层 + 它前面紧邻的、尚未覆盖的(用户)楼层
  const covered = coveredSet(chat);
  const targets: number[] = [aiFloor];
  for (let i = aiFloor - 1; i >= 0; i--) {
    if (covered.has(i)) break;
    if (isAiFloor(chat[i])) break; // 碰到上一个 AI 楼层就停
    if (chat[i]) targets.unshift(i);
  }

  busy = true;
  engineState.running = true;
  engineState.lastError = '';
  try {
    const content = renderMessages(chat, targets, ctx.name1, ctx.name2);

    // 时间锚点:先从正文标签读起止时间(权威源)。两端都齐才算「有标签」,提示词据此免去 AI 算时间。
    // 先裁剪到正文段再解析,跳过思维链/状态栏里可能混入的同名标签。
    const tag = parseTimeRange(clampToTimeTags(chat[aiFloor].mes));
    const hasTimeTags = !!(tag.start && tag.end);

    // 截止到「被分析楼段之前」的状态与历史(不泄漏未来:重摘早期楼时排除其后叶子)
    const beforeIndex = targets[0];
    const stateBefore = deriveMemory(chat, beforeIndex);
    const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, beforeIndex));

    // 世界书:按本轮文本激活相关条目(含 constant 常驻),给摘要模型设定依据,避免与世界观矛盾
    const worldInfo = await fetchWorldInfo(chat, targets, ctx.name1, ctx.name2);
    // 角色卡描述:有些卡人设写在角色描述而非世界书里,一并带上(空/群聊自动跳过)
    const charCard = fetchCharCard();

    // 未了结计划的有序列表:顺序即提示词里的 p1/p2…,用于把 AI 的 resolve 短序号翻译成稳定 id
    const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
    const prompt = buildSummaryPrompt({
      user: ctx.name1,
      char: ctx.name2,
      time: stateBefore.state.time,
      location: stateBefore.state.location,
      items: stateBefore.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })),
      // 变动日志已随 deriveMemory(chat, beforeIndex) 截断到本段之前,不泄漏未来
      itemLog: stateBefore.itemLog,
      openPlans: openPlansOrdered.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })),
      history,
      content,
      hasTimeTags,
    });

    // 组装:破限(置顶)→ 角色设定 + 世界设定(各独立 system,有才加)→ 主提示 → 思考清单 → assistant 预填。
    // 破限留空=用内置默认(与摘要/总结提示词同一回退语义);确实不想要可在设置里删成默认后再清。
    const messages: ChatMsg[] = [];
    const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
    if (jb) messages.push({ role: 'system', content: jb });
    if (charCard) messages.push({ role: 'system', content: buildCharCardSystem(charCard) });
    if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
    messages.push(
      { role: 'user', content: prompt },
      { role: 'system', content: THINKING_CHECKLIST },
      { role: 'assistant', content: THINKING_PREFILL },
    );
    // 发请求 + 解析,失败按设置重试(请求报错或 JSON 无效/缺 summary 都算失败)
    const delta = await sendAndParse(sender.send, messages, raw => {
      console.log('[柏宝书] 摘要原始返回(未清洗):\n', raw);
      const d = extractJsonObject<SummaryDelta>(raw);
      if (!d || !d.summary) {
        // 有文本但抽不出所需格式 = AI 道歉/掉格式;整段空白 = AI 空回
        throw new Error(raw.trim() ? '摘要失败:AI道歉或掉格式' : '摘要失败:AI空回');
      }
      return d as SummaryDelta & { summary: string };
    });

    // 固化 delta(resolve 短序号→稳定 plan id),写成叶子挂到 AI 楼的 extra(随消息/swipe 跟随)
    const storedDelta = finalizeDelta(delta, openPlansOrdered);

    // 时间起止:标签优先(权威锚点,与新剧情同源不漂移);标签缺的那端用 AI 补的 timeStart/timeEnd 兜底。
    const timeStart = tag.start || delta.timeStart?.trim() || undefined;
    const timeEnd = tag.end || delta.timeEnd?.trim() || delta.time?.trim() || undefined;
    // 状态当前时间(覆盖型):用结束时间(本段最后时刻);取不到则保留既有状态。
    if (timeEnd) storedDelta.time = timeEnd;

    const leaf: LeafExtra = {
      id: makeLeafId(),
      text: delta.summary.trim(),
      delta: storedDelta,
      timeStart,
      timeEnd,
      createdAt: Date.now(),
      // 记录生成时所在页码,供 leafValid 判定归属(翻到别页时不串扰);缺 swipe_id 按第一页 0
      swipe: typeof chat[aiFloor].swipe_id === 'number' ? chat[aiFloor].swipe_id : 0,
      v: 1,
    };
    chat[aiFloor].extra = { ...(chat[aiFloor].extra ?? {}), bbs_leaf: leaf };

    // 把本楼物品净变动写进正文 </bbs_end> 之后(<bbs_items> 旁注,正则隐藏显示、不进副API摘要):
    // 窗口内全文楼层会被主模型看到,提示「这笔账已结算」;滚出窗口自然消失,符合取舍。
    // 用 stateBefore.items(本楼之前的物品)作基准算 from→to;无变动则只清旧块。
    const changes = itemChangesOf(storedDelta, stateBefore.items, timeEnd || timeStart || '');
    chat[aiFloor].mes = writeItemLogTag(chat[aiFloor].mes, fmtItemLogInline(changes));

    engineState.lastRunAt = Date.now();

    // 立刻反映到派生与注入;落盘走防抖(隐藏由收尾的 syncWindowHiddenState 统一负责)
    recomputeDerived();
    refreshInjection();
    scheduleLeafFlush();
    scheduleVectorIndex(); // 新叶子 → 防抖同步进向量库(失败静默,不影响摘要)

    // 摘要积累到阈值则触发总结
    await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
  }
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
    const content = batch.map((s, i) => `[${i + 1}] ${s.text}`).join('\n\n');
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
