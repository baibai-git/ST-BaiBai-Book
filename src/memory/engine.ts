import type { ChatMsg } from '@/api/client';
import { requestCompletion } from '@/api/client';
import { apiSettings, getChannelForTask } from '@/api/settings';
import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { addSummary, applyDelta } from './apply';
import { extractJsonObject } from './json';
import { refreshInjection } from './inject';
import { buildResummaryPrompt, buildSummaryPrompt } from './prompts';
import { memory, saveMemory } from './store';
import type { SummaryDelta } from './types';

/** 引擎运行状态(供 UI 显示) */
import { reactive } from 'vue';
export const engineState = reactive({
  running: false,
  lastError: '' as string,
  lastRunAt: 0,
});

let busy = false;

/**
 * 收集"尚未被任何摘要覆盖"的消息索引。
 */
function uncoveredIndices(chat: STMessage[]): number[] {
  const covered = new Set<number>();
  for (const s of memory.summaries) {
    for (const i of s.coveredIndices) covered.add(i);
  }
  const out: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (!covered.has(i)) out.push(i);
  }
  return out;
}

/** 把消息渲染成给摘要模型的文本 */
function renderMessages(chat: STMessage[], indices: number[], name1: string, name2: string): string {
  return indices
    .map(i => {
      const m = chat[i];
      if (!m) return '';
      const who = m.is_user ? name1 || 'User' : m.name || name2 || 'Char';
      return `【${who}】${stripHtml(m.mes)}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function stripHtml(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

/**
 * 是否「可追踪的 AI 楼层」。对齐 Horae 的 _isTrackableAiMessage,并与「是否对主 LLM 可见」解耦:
 * 隐藏旧楼用 is_system=true,但被我们隐藏的旧 AI 楼(打了 extra.bbs_hidden)仍要算作 AI 楼,
 * 否则 keepStart / 覆盖统计会被破坏。三态:
 *   ① 可见 AI 楼:!is_user && !is_system
 *   ② 我们隐藏的旧 AI 楼:is_system && extra.bbs_hidden  → 仍算 AI 楼
 *   ③ ST 原生系统楼(欢迎语/sys 等):is_system && !bbs_hidden → 不算
 */
export function isAiFloor(m: STMessage | undefined): boolean {
  if (!m || m.is_user) return false;
  if (typeof m.mes !== 'string' || !m.mes.trim()) return false;
  if (m.extra?.bbs_hidden) return true; // 被我们隐藏的旧 AI 楼
  return !m.is_system; // 其余:非 ST 原生系统楼才算
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
 * 找出"待摘要"的 AI 楼层:**所有**尚未被任何摘要覆盖的 AI 楼(由旧到新)。
 * 注意:摘要的「生成」与「使用」解耦——每个 AI 楼层都尽早生成摘要(包括仍在保留窗口、
 * 当前发全文的楼层),只是窗口内的摘要暂存不注入;待楼层滑出窗口被隐藏时,其摘要才启用。
 * 所以这里不按 keepStart 设限,保证摘要提前备好、滑出即可顶上。
 */
export function pendingAiFloors(chat: STMessage[]): number[] {
  const uncovered = new Set(uncoveredIndices(chat));
  const out: number[] = [];
  for (let i = 0; i < chat.length; i++) {
    if (uncovered.has(i) && isAiFloor(chat[i])) out.push(i);
  }
  return out;
}

/**
 * 自动摘要检查:由用户发消息 / AI 回复事件触发。
 * 生成与使用解耦:① 给所有未覆盖 AI 楼生成摘要(含窗口内的,提前备好);
 * ② 保留窗口之外的楼层隐藏(原文踢出上下文);③ 只注入已隐藏楼层的摘要。
 */
export async function checkAutoSummary(): Promise<void> {
  console.log('[柏宝书] checkAutoSummary 进入', { enabled: apiSettings.autoSummaryEnabled, busy });
  if (!apiSettings.autoSummaryEnabled) { console.log('[柏宝书] 早退:自动摘要未开启'); return; }
  if (busy) { console.log('[柏宝书] 早退:busy 锁'); return; }

  const ctx = getContext();
  if (!ctx) { console.log('[柏宝书] 早退:无 ctx'); return; }
  const chat = ctx.chat ?? [];
  if (chat.length === 0) { console.log('[柏宝书] 早退:chat 为空'); return; }

  const floors = pendingAiFloors(chat);
  console.log('[柏宝书] 待摘要楼层 =', floors);
  // 1) 给所有尚未覆盖的 AI 楼逐个生成摘要(包括仍在保留窗口的,暂存不注入)
  for (const floor of floors) {
    await runSummary(floor);
  }

  // 2) 滑动隐藏:保留窗口之外、已被摘要覆盖的消息踢出主上下文
  if (apiSettings.autoHide) {
    await applyWindowHide(chat);
  }

  // 3) 刷新注入(只注入已隐藏楼层的摘要——见 inject.ts)
  refreshInjection();
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
 * 隐藏「保留窗口之前、已被摘要覆盖、尚未隐藏」的消息。
 * 走 ST 原生 /hide(对齐 Horae、自动同步 DOM、走官方入口),
 * 同时打 extra.bbs_hidden 私有标记区分「我们隐藏的」与「ST 原生系统楼」。
 * 只隐藏已被摘要覆盖的,绝不制造信息黑洞。
 */
async function applyWindowHide(chat: STMessage[]): Promise<void> {
  const keepStart = resolveKeepStart(chat);
  if (keepStart <= 0) return;
  const covered = coveredSet();
  const ctx = getContext();
  if (!ctx) return;

  const toHide: number[] = [];
  for (let i = 0; i < keepStart; i++) {
    const m = chat[i];
    if (!m || !covered.has(i)) continue;
    if (m.extra?.bbs_hidden) continue;
    // 预写私有标记 + 内存态,防止 /hide 异步期间的竞态 saveChat 覆盖
    m.extra = { ...(m.extra ?? {}), bbs_hidden: true };
    toHide.push(i);
  }
  if (toHide.length === 0) return;

  const exec = ctx.executeSlashCommandsWithOptions;
  if (typeof exec === 'function') {
    for (const [start, end] of coalesceRanges(toHide)) {
      const arg = start === end ? `${start}` : `${start}-${end}`;
      try {
        await exec(`/hide ${arg}`);
      } catch (e) {
        // /hide 失败则回退到直接写 is_system,保证隐藏一定落地
        for (let i = start; i <= end; i++) if (chat[i]) chat[i].is_system = true;
        engineState.lastError = `/hide ${arg} 失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
  } else {
    // 无 slash 执行器(旧版/未就绪):回退直接写 is_system + 重载
    for (const i of toHide) if (chat[i]) chat[i].is_system = true;
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

  // 覆盖范围:本 AI 楼层 + 它前面紧邻的、尚未覆盖的(用户)楼层
  const covered = new Set(coveredSet());
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
    const openPlans = memory.plans.filter(p => p.status === 'open').map(p => ({ kind: p.kind, content: p.content }));
    const prompt = buildSummaryPrompt({
      user: ctx.name1,
      char: ctx.name2,
      time: memory.state.time,
      location: memory.state.location,
      items: memory.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc })),
      openPlans,
      content,
    });

    const messages: ChatMsg[] = [{ role: 'user', content: prompt }];
    const raw = await requestCompletion(channel, messages);
    const delta = extractJsonObject<SummaryDelta>(raw);
    if (!delta || !delta.summary) {
      throw new Error('摘要解析失败:未得到有效 JSON 或缺 summary 字段');
    }

    // 先记录摘要拿到 id,再施加结构化增量(给衍生物品/计划打来源标记,便于删除时连带清除)
    const rec = addSummary({
      text: delta.summary.trim(),
      coveredIndices: targets,
      depth: 1,
      auto: true,
      timeLabel: delta.time || memory.state.time || undefined,
    });
    applyDelta(delta, rec.id);

    engineState.lastRunAt = Date.now();

    // 单步补摘要也立刻反映到注入(隐藏由 checkAutoSummary 末尾的 applyWindowHide 统一负责)
    refreshInjection();

    // 摘要积累到阈值则触发总结
    await checkResummary();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  } finally {
    busy = false;
    engineState.running = false;
  }
}

/** 当前已被覆盖的索引集合 */
function coveredSet(): Set<number> {
  const s = new Set<number>();
  for (const sum of memory.summaries) for (const i of sum.coveredIndices) s.add(i);
  return s;
}

/**
 * 二次总结:当 depth=1 的摘要数量达到阈值时,把它们融合成 depth=2 摘要。
 */
export async function checkResummary(): Promise<void> {
  const threshold = apiSettings.resummaryThreshold;
  if (!threshold || threshold < 2) return;

  const firstLevel = memory.summaries.filter(s => s.depth === 1);
  if (firstLevel.length < threshold) return;

  const channel = getChannelForTask('resummary');
  if (!channel) {
    engineState.lastError = '未指派"总结"副 API 渠道';
    return;
  }

  const ctx = getContext();
  if (!ctx) return;

  // 取最早的 threshold 条融合
  const batch = firstLevel.slice(0, threshold);
  const content = batch.map((s, i) => `[${i + 1}] ${s.text}`).join('\n\n');
  const prompt = buildResummaryPrompt({ user: ctx.name1, char: ctx.name2, content });

  try {
    const raw = await requestCompletion(channel, [{ role: 'user', content: prompt }]);
    const delta = extractJsonObject<{ summary?: string }>(raw);
    if (!delta?.summary) throw new Error('二次总结解析失败');

    const mergedIndices = batch.flatMap(s => s.coveredIndices);
    const mergedIds = batch.map(s => s.id);

    // 移除被合并的一层摘要,加入二层摘要
    memory.summaries = memory.summaries.filter(s => !mergedIds.includes(s.id));
    addSummary({
      text: delta.summary.trim(),
      coveredIndices: mergedIndices,
      depth: 2,
      auto: true,
      mergedFrom: mergedIds,
    });
    saveMemory();
    refreshInjection();
  } catch (e) {
    engineState.lastError = e instanceof Error ? e.message : String(e);
  }
}

/**
 * 绑定事件。checkAutoSummary 幂等(遍历所有未覆盖楼层,已摘要的跳过)+ busy 锁,
 * 多个事件触发同一次检查安全,重复只会早退,不会重复发请求。所有摘要触发都用
 * fire-and-forget(不 await),避免阻塞 ST 的 emit(emit 会 await 监听器)。
 *  - USER_MESSAGE_RENDERED:用户发消息(主生成之前)→ 与主生成并行。
 *  - GENERATION_STARTED:任意生成开始时(主生成之前)→ 让重新生成/翻页也能并行。
 *    过滤 dryRun / quiet / impersonate(非真实 AI 回复)。
 *  - CHAT_CHANGED:切聊天后记忆已重载,刷新注入。
 * 摘要走独立 fetch、不经 ST 的 Generate,不会触发 GENERATION_STARTED 自循环。
 */
export function bindEngine(): void {
  const ctx = getContext();
  if (!ctx?.eventSource || !ctx?.eventTypes) return;
  const es = ctx.eventSource;
  const et = ctx.eventTypes;

  console.log('[柏宝书] bindEngine 执行,监听', et.USER_MESSAGE_RENDERED, et.GENERATION_STARTED);

  // 主路径:用户发消息瞬间(主生成尚未开始)并行摘要
  es.on(et.USER_MESSAGE_RENDERED, () => {
    console.log('[柏宝书] USER_MESSAGE_RENDERED 触发(并行)');
    void checkAutoSummary();
  });

  // 覆盖重新生成 / 翻页:它们没有 user message,但都在生成开始时 emit GENERATION_STARTED。
  // 此刻新回复还没写进 chat,正好趁机并行摘「上一楼」。
  if (et.GENERATION_STARTED) {
    es.on(et.GENERATION_STARTED, (type?: string, _opts?: unknown, dryRun?: boolean) => {
      if (dryRun) return;
      if (type === 'quiet' || type === 'impersonate') return; // 静默/替用户生成,非真实 AI 回复
      console.log('[柏宝书] GENERATION_STARTED 触发(并行), type =', type);
      void checkAutoSummary();
    });
  }

  if (et.CHAT_CHANGED) {
    es.on(et.CHAT_CHANGED, () => {
      // 记忆重载由 store 的 CHAT_CHANGED 监听负责;此处仅在其后刷新注入
      setTimeout(() => refreshInjection(), 0);
    });
  }
}
