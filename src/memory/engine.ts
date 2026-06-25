import type { ChatMsg } from '@/api/client';
import { requestCompletion } from '@/api/client';
import { apiSettings, engineActiveHere, getChannelForTask } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { addSummary, deriveMemory, finalizeDelta, getLeaf, leafHash, leafValid, makeLeafId, pruneBrokenComps, stripHtml } from './apply';
import { extractJsonObject } from './json';
import { clearInjection, refreshInjection, renderHistoryNodes, selectHistoryNodesBefore } from './inject';
import { buildResummaryPrompt, buildSummaryPrompt, buildWorldInfoSystem, JAILBREAK_PROMPT, THINKING_CHECKLIST, THINKING_PREFILL } from './prompts';
import { clampToTimeTags, inlineTimeTags, parseTimeRange, syncTimeTagRegex } from './timeTag';
import { memory, recomputeDerived, scheduleLeafFlush } from './store';
import type { LeafExtra, SummaryDelta } from './types';

/** 引擎运行状态(供 UI 显示) */
import { reactive, watch } from 'vue';
export const engineState = reactive({
  running: false,
  lastError: '' as string,
  lastRunAt: 0,
});

let busy = false;

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
 * 「积压」楼层:已滑出保留窗口(< keepStart)、却仍没有有效叶子的 AI 楼。
 * 这才是真正漏摘的部分——最近 keepRecent 条本就发全文、最后才摘,不算积压,
 * 否则正常使用每轮都会有 1 条「最新待摘」而被误判。
 */
export function backlogFloors(chat: STMessage[]): number[] {
  const keepStart = resolveKeepStart(chat);
  return pendingAiFloors(chat).filter(i => i < keepStart);
}

// 提示楼正文里的固定句,既给用户看,也用作「末楼是否已是本提示楼」的去重哨兵
const BACKLOG_NOTICE_SENTINEL = '本次生成已拦截';

/**
 * 生成拦截器:正常发消息前,若保留窗口外仍有未摘楼层(积压 >= 1)则中止本次生成,
 * 并用 /sendas 插一条提示楼,引导用户去摘要页补摘。
 * 只拦 type==='normal'(翻页/重生成/续写/安静生成都放行)。
 * 跟随「自动摘要」开关(不再独立);返回是否已拦截。
 */
export async function handleGenerationIntercept(
  type: string | undefined,
  abort: (immediately: boolean) => void,
): Promise<boolean> {
  if (!engineActiveHere()) return false; // 排除角色/总开关关:不拦
  if (!apiSettings.autoSummaryEnabled) return false; // 自动摘要关 → 积压拦截一并关
  if (type !== 'normal') return false; // 只拦真正的新消息生成

  const ctx = getContext();
  if (!ctx) return false;
  if (!ctx.getCurrentChatId?.()) return false; // 欢迎页:无聊天不拦
  const chat = ctx.chat ?? [];
  const backlog = backlogFloors(chat);
  if (backlog.length < 1) return false;

  abort(true); // 立即中止,后续拦截器也不再跑

  // 去重:末楼已是本提示楼就不再重复插(连点发送不刷屏)
  const last = chat[chat.length - 1];
  if (last && !last.is_user && typeof last.mes === 'string' && last.mes.includes(BACKLOG_NOTICE_SENTINEL)) {
    return true;
  }

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    // 多行靠 {{newline}} 宏(sendMessageAs 走 substituteParams 会还原成换行)
    const text = [
      '[柏宝书]',
      `前面存在过多楼层未生成摘要(${backlog.length} 层),为保证剧情连续性,请先在柏宝书界面的摘要页里,点击未摘要楼层的楼层号进行生成摘要。`,
      BACKLOG_NOTICE_SENTINEL,
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
 * 自动触发的单楼增量摘要:只确保「上一条已定稿 AI 消息」有摘要,且只摘那一条。
 * @param skipLastAi true 时跳过正在操作的末尾 AI 消息(翻页/重新生成场景),取它之前的那条 AI。
 *
 * 规则(对齐用户语义):
 *  - 发消息:目标 = 最后一条 AI 消息(它刚定稿)。skipLastAi=false。
 *  - 翻页/重新生成:末尾 AI 正在被改写(易变),跳过它,目标 = 之前那条 AI。skipLastAi=true。
 *    例:#0 开场白、#1 用户、#2 最新 AI,在 #2 翻页 → 跳过 #2 → 目标 #0。
 */
export async function maybeSummarizePrevAi(skipLastAi: boolean): Promise<void> {
  if (!engineActiveHere()) return;
  if (!apiSettings.autoSummaryEnabled) return;
  if (busy) return;
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (chat.length === 0) return;

  const target = prevAiFloor(chat, skipLastAi);
  if (target < 0) return; // 没有可摘的「上一条 AI」
  if (leafValid(chat[target])) {
    // 上一条 AI 已有有效摘要 → 无需重摘,但仍跑收尾(隐藏窗口可能变化)
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
export async function runSummary(aiFloor: number): Promise<void> {
  console.log('[柏宝书] runSummary 楼层', aiFloor, '| busy =', busy);
  if (!engineActiveHere()) { console.log('[柏宝书] runSummary 早退:插件总开关关闭或当前角色被排除'); return; }
  if (busy) { console.log('[柏宝书] runSummary 早退:busy'); return; }
  const channel = getChannelForTask('summary');
  if (!channel) {
    engineState.lastError = '未指派"摘要"副 API 渠道';
    console.log('[柏宝书] runSummary 早退:摘要渠道未指派');
    return;
  }
  const ctx = getContext();
  if (!ctx) return;
  const chat = ctx.chat ?? [];
  if (!isAiFloor(chat[aiFloor])) { console.log('[柏宝书] runSummary 早退:非 AI 楼', aiFloor); return; }
  console.log('[柏宝书] runSummary 即将发请求,渠道 =', channel.name, 'model =', channel.model);

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

    // 未了结计划的有序列表:顺序即提示词里的 p1/p2…,用于把 AI 的 resolve 短序号翻译成稳定 id
    const openPlansOrdered = stateBefore.plans.filter(p => p.status === 'open');
    const prompt = buildSummaryPrompt({
      user: ctx.name1,
      char: ctx.name2,
      time: stateBefore.state.time,
      location: stateBefore.state.location,
      items: stateBefore.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc })),
      openPlans: openPlansOrdered.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })),
      history,
      content,
      hasTimeTags,
    });

    // 组装:破限(置顶)→ 世界设定(独立 system,有才加)→ 主提示 → 思考清单 → assistant 预填。
    // 破限留空=用内置默认(与摘要/总结提示词同一回退语义);确实不想要可在设置里删成默认后再清。
    const messages: ChatMsg[] = [];
    const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
    if (jb) messages.push({ role: 'system', content: jb });
    if (worldInfo) messages.push({ role: 'system', content: buildWorldInfoSystem(worldInfo) });
    messages.push(
      { role: 'user', content: prompt },
      { role: 'system', content: THINKING_CHECKLIST },
      { role: 'assistant', content: THINKING_PREFILL },
    );
    const raw = await requestCompletion(channel, messages);
    const delta = extractJsonObject<SummaryDelta>(raw);
    if (!delta || !delta.summary) {
      throw new Error('摘要解析失败:未得到有效 JSON 或缺 summary 字段');
    }

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
      srcHash: leafHash(chat[aiFloor].mes),
      v: 1,
    };
    chat[aiFloor].extra = { ...(chat[aiFloor].extra ?? {}), bbs_leaf: leaf };

    engineState.lastRunAt = Date.now();

    // 立刻反映到派生与注入;落盘走防抖(隐藏由收尾的 syncWindowHiddenState 统一负责)
    recomputeDerived();
    refreshInjection();
    scheduleLeafFlush();

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

    const channel = getChannelForTask('resummary');
    if (!channel) {
      engineState.lastError = '未指派"总结"副 API 渠道';
      return made;
    }

    const batch = roots.slice(0, threshold);
    const content = batch.map((s, i) => `[${i + 1}] ${s.text}`).join('\n\n');
    const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content });

    try {
      const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
      const messages: ChatMsg[] = [];
      if (jb) messages.push({ role: 'system', content: jb });
      messages.push({ role: 'user', content: prompt });
      const raw = await requestCompletion(channel, messages);
      const delta = extractJsonObject<{ summary?: string }>(raw);
      if (!delta?.summary) throw new Error('总结解析失败');

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
  if (et.MESSAGE_EDITED) es.on(et.MESSAGE_EDITED, () => reactToChatMutation());
  if (et.MESSAGE_DELETED) es.on(et.MESSAGE_DELETED, () => reactToChatMutation(true));

  // AI 新回复落定:不一定会触发摘要(自动摘要关闭 / 它不是「上一条 AI」),
  // 但「未摘要楼层」列表必须跟上新增的 AI 楼,故无条件重算一次派生缓存(不发请求)。
  if (et.CHARACTER_MESSAGE_RENDERED) es.on(et.CHARACTER_MESSAGE_RENDERED, () => recomputeDerived());

  if (et.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, () => {
      // 记忆重载由 store 的 CHAT_CHANGED 监听负责;此处仅在其后刷新注入
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
