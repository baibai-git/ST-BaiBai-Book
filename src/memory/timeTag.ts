/**
 * 时间标签(锚点)——让主对话模型在每条正文前后输出起止时间,把「时间」从事后推断变成正文事实。
 *
 * 解决两个老问题:
 *  1. 一层楼时间跨度大,单一时间快照取不准 → 现在有起始 + 结束两个界。
 *  2. 摘要请求与新剧情生成并行,各自推断时间导致错乱 → 两边都读正文里同一个权威时间,自然同步。
 *
 * 标签格式固定为 <bbs_start>…</bbs_start> / <bbs_end>…</bbs_end>(bbs_ 前缀避免与其它插件/世界书撞)。
 * 标签**留在正文里**(发副 API、发主模型续写都带着),只用 ST 正则在「显示层」隐藏 —— 真删会让时间再次失同步。
 */

import { apiSettings } from '@/api/settings';
import { getContext, type STMessage } from '@/st/context';

/** 标签固定标识(解析正则与隐藏正则都依赖它) */
export const START_TAG = 'bbs_start';
export const END_TAG = 'bbs_end';

/** 注入主对话的固定提示词默认值(可在设置里覆盖)。 */
export const TIME_TAG_PROMPT = `【时间锚点要求(系统强制)】
在你每次输出正文的最前面和最后面,各放一个时间标签,标明这段剧情的开始时刻与结束时刻:

<${START_TAG}>本段开始时的故事内时间</${START_TAG}>
（正文……）
<${END_TAG}>本段结束时的故事内时间</${END_TAG}>

规则:
- 时间要具体、可明确定位,风格与正文世界观一致:现代题材用数字日期时间(如 1988/9/29 21:30);古风/奇幻题材用相应的纪年与时辰(如 庆历四年暮春·辰时三刻)。重点是「能定位到某一刻」,不强求阿拉伯数字。
- 禁止"稍后""不久""某天""同一天"等无法定位到具体时刻的模糊说法。
- 以上一段的结束时间为基准,结合本段剧情合理推进(对话约几分钟、用餐约一小时、过夜跨到次日等)。
- 若这是故事开篇、此前没有任何已知时间,请你自行设定一个符合本世界观的具体起始时刻,之后以此为基准推进——这是为记忆系统建立时间锚点所必需的合理设定,不算编造;但绝不能用"某天"这类无法定位的占位词敷衍。
- 标签只各出现一次,分别紧贴正文最前与最后;标签内只有时间,不要写别的。
- 这两个标签是给记忆系统读取的锚点,请务必每次都输出。`;

/** 当前生效的固定提示词(用户自定义优先,空则用内置默认)。 */
export function timeTagPrompt(): string {
  return apiSettings.prompts.timeTag.trim() || TIME_TAG_PROMPT;
}

// 解析用正则:容忍标签名大小写与首尾空白;非贪婪取内部文本。
const RE_START = new RegExp(`<${START_TAG}\\b[^>]*>([\\s\\S]*?)</${START_TAG}>`, 'i');
const RE_END = new RegExp(`<${END_TAG}\\b[^>]*>([\\s\\S]*?)</${END_TAG}>`, 'i');

/** 从一段正文里解析起止时间;取不到的为 undefined(降级:调用方各自兜底)。 */
export function parseTimeRange(mes: string): { start?: string; end?: string } {
  const s = String(mes ?? '');
  const start = s.match(RE_START)?.[1]?.trim() || undefined;
  const end = s.match(RE_END)?.[1]?.trim() || undefined;
  return { start, end };
}

/**
 * 当前「故事内最新时间」:从 chat 末尾往前扫,取第一条能从正文标签解析出的时间(end 优先,缺则 start)。
 *
 * 为什么不直接用派生的 memory.state.time:那个只重放「已生成叶子」的楼层,最新几层没摘时就停在旧值。
 * 而最新 AI 楼正文里本就带 <bbs_end>,这里直接读它,无论摘没摘都拿到真实最新时间。
 * 用途:① 摘要页「当前时间」展示;② 历史摘要注入时相对时间的参照点(「现在」)。
 * 解析不到(纯架空/无标签)→ 返回空串,调用方各自回退。
 */
export function latestStoryTime(chat: STMessage[] | null): string {
  if (!chat) return '';
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (typeof m?.mes !== 'string' || !m.mes) continue;
    const { start, end } = parseTimeRange(clampToTimeTags(m.mes));
    const t = end || start;
    if (t) return t;
  }
  return '';
}

/**
 * 裁剪到时间标签区间:移除 <bbs_start> 之前、</bbs_end> 之后的所有文本(标签本身保留)。
 * 用于喂摘要模型前,剔除角色卡的状态栏、页眉页脚等正文之外的格式,避免干扰摘要生成。
 *
 * 取「最后一个 <bbs_start>」+「第一个 </bbs_end>」——思维链/状态栏里可能混入同名标签,
 * 思维链通常在正文前(故真正的开始标签是最后一个),正文的结束标签则是第一个出现的,
 * 这样能跳过这些干扰标签、精准框出真正的正文段。
 * 仅在对应标签存在时才裁剪;缺标签的一侧保持原样(两侧都没有则完全不动)。
 */
export function clampToTimeTags(mes: string): string {
  let s = String(mes ?? '');
  // 最后一个 <bbs_start> 的位置:全局扫一遍取末次
  const startRe = new RegExp(`<${START_TAG}\\b`, 'gi');
  let lastStart = -1;
  for (let m = startRe.exec(s); m; m = startRe.exec(s)) lastStart = m.index;
  if (lastStart >= 0) s = s.slice(lastStart);
  // 第一个 </bbs_end>(在已裁过前缀的串里找)
  const endMatch = s.match(new RegExp(`</${END_TAG}>`, 'i'));
  if (endMatch && endMatch.index !== undefined) {
    s = s.slice(0, endMatch.index + endMatch[0].length);
  }
  return s;
}

/**
 * 把正文里的时间标签转成可读内联文本(供喂给摘要模型前预处理)。
 * stripHtml 会把 <bbs_start>…</bbs_start> 整段删掉(含内部时间),摘要模型就看不到时间了;
 * 故先转成「(起始时间:X)/(结束时间:X)」纯文本,再交给 stripHtml 清其余标签。
 */
export function inlineTimeTags(mes: string): string {
  return String(mes ?? '')
    .replace(RE_START, (_, t) => `(起始时间:${String(t).trim()})`)
    .replace(RE_END, (_, t) => `(结束时间:${String(t).trim()})`);
}

// 时间段压缩用的「分隔边界」:回退公共前缀到这些字符之后,避免切到 token 中间。
// 只含「日期段/时刻段」之间的分隔符(空格 / － 与中文日期单位 年月日),
// 故意不含 : 与 时/点 —— 那会把 06:45 的时分也切碎(切成 55),只想压掉重复的日期前缀。
const RANGE_BOUNDARY = /[\s/／\-－年月日]/;

/**
 * 压缩「起 - 止」时间段:删掉结束时间里与开始时间重复的前缀(多为日期),
 * 让 "2023/9/10 06:45 - 2023/9/10 06:55" 显示成 "2023/9/10 06:45 - 06:55"。
 *
 * 通用做法(不解析具体日期格式):取首尾最长公共前缀,回退到最近的分隔边界(含),
 * 把这段前缀从结束时间里删掉。标准格式与古风("庆历四年春 辰时")都适用;
 * 两串前缀不重合时压不动,原样保留全串——零误伤,无需判断「能否解析」。
 */
function compactPair(a: string, b: string): string {
  if (!a || !b) return a || b || '';
  if (a === b) return a;
  if (a.startsWith(b)) return a; // 结束时间是开始时间的前缀(无新信息)→ 只显示开始
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n++;
  // 回退到公共前缀内最后一个边界字符之后
  let cut = 0;
  for (let i = 0; i < n; i++) if (RANGE_BOUNDARY.test(a[i])) cut = i + 1;
  const tail = b.slice(cut).trim();
  return tail ? `${a} - ${tail}` : a;
}

/**
 * 把起止时间格式化成展示用的时间段串:
 *  - 都有且不同 → 压缩后的 "start - end";都有且相同 → "start";只有一个 → 那一个;都无 → ''。
 */
export function formatRange(start?: string, end?: string): string {
  const a = start?.trim();
  const b = end?.trim();
  if (a && b) return compactPair(a, b);
  return a || b || '';
}

/**
 * 把已存为完整串的展示标签("起 - 止")再压缩一次,供列表显示用。
 * 用于历史数据:旧摘要的 timeLabel 已固化成完整串,展示时即时压缩,无需迁移。
 * 对已压缩的标签幂等(再切再压结果不变)。无 " - " 分隔的单点串原样返回。
 */
export function compactTimeLabel(label: string): string {
  const s = String(label ?? '').trim();
  const i = s.indexOf(' - ');
  if (i < 0) return s;
  return compactPair(s.slice(0, i).trim(), s.slice(i + 3).trim());
}

/**
 * 把旧数据里固化成单字段的 timeLabel 拆回 {start,end},供迁移到 timeStart/timeEnd。
 * 无 " - " 分隔的单点串 → start=end=该串。空串 → 两者皆 undefined。
 */
export function splitTimeLabel(label?: string): { start?: string; end?: string } {
  const s = String(label ?? '').trim();
  if (!s) return {};
  const i = s.indexOf(' - ');
  if (i < 0) return { start: s, end: s };
  return { start: s.slice(0, i).trim() || undefined, end: s.slice(i + 3).trim() || undefined };
}

/* ============ 自动注册「仅显示层隐藏」正则到 ST ============ */

// ST 全局正则脚本存在 extension_settings.regex(数组)。我们用固定 id 标识自己这条,做到幂等。
const HIDE_SCRIPT_ID = 'bbs-time-tag-hide';
const HIDE_SCRIPT_NAME = '柏宝书 · 隐藏时间标签';
// regex_placement(见 ST regex/engine.js):0=MD_DISPLAY 1=USER_INPUT 2=AI_OUTPUT
const PLACEMENT_MD_DISPLAY = 0;
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;

/** 一条同时吃掉 start/end 标签(含其内部时间)的正则字符串(ST 用 /pattern/flags 形式) */
function hideFindRegex(): string {
  return `/<\\/?(?:${START_TAG}|${END_TAG})\\b[^>]*>(?:[\\s\\S]*?<\\/(?:${START_TAG}|${END_TAG})>)?/gi`;
}

/**
 * 确保 ST 里存在我们的「隐藏时间标签」正则脚本(仅影响显示,不影响提示词)。
 * 幂等:按固定 id 查,缺则补、已存在则更新内容(防止旧版本格式残留)。用户手动删了下次启动会再加回。
 */
export function ensureHideRegexRegistered(): void {
  const ctx = getContext();
  const es = ctx?.extensionSettings as Record<string, unknown> | undefined;
  if (!es) return;
  if (!Array.isArray(es.regex)) es.regex = [];
  const list = es.regex as Array<Record<string, unknown>>;

  const script = {
    id: HIDE_SCRIPT_ID,
    scriptName: HIDE_SCRIPT_NAME,
    findRegex: hideFindRegex(),
    replaceString: '',
    trimStrings: [] as string[],
    // 只作用于「显示」:MD_DISPLAY;同时清掉用户输入/AI 输出显示里的残留标签,但不进提示词。
    placement: [PLACEMENT_MD_DISPLAY, PLACEMENT_USER_INPUT, PLACEMENT_AI_OUTPUT],
    disabled: false,
    markdownOnly: true, // = 仅格式化显示,不改写发给模型的提示词(关键:标签必须留在提示词里)
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };

  const idx = list.findIndex(s => s?.id === HIDE_SCRIPT_ID);
  if (idx >= 0) list[idx] = { ...list[idx], ...script };
  else list.push(script);
  ctx?.saveSettingsDebounced?.();
}

/** 移除我们注册的隐藏正则(关闭时间标签功能时调用)。 */
export function removeHideRegex(): void {
  const ctx = getContext();
  const es = ctx?.extensionSettings as Record<string, unknown> | undefined;
  if (!es || !Array.isArray(es.regex)) return;
  const list = es.regex as Array<Record<string, unknown>>;
  const next = list.filter(s => s?.id !== HIDE_SCRIPT_ID);
  if (next.length !== list.length) {
    es.regex = next;
    ctx?.saveSettingsDebounced?.();
  }
}

/**
 * 同步时间标签功能的副作用(开关变化或启动时调用):
 *  - 开:注册隐藏正则;关:移除。提示词注入由 inject.ts 的 refreshInjection 负责。
 * 跟随「自动摘要」开关(时间标签不再独立)。
 */
export function syncTimeTagRegex(): void {
  if (apiSettings.autoSummaryEnabled) ensureHideRegexRegistered();
  else removeHideRegex();
}
