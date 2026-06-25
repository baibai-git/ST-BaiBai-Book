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
import { getContext } from '@/st/context';

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
- 时间用具体、数字化的日期时间(如 1988/9/29 21:30),禁止"稍后""不久"等模糊词。
- 以上一段的结束时间为基准,结合本段剧情合理推进时间。
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
 * 把正文里的时间标签转成可读内联文本(供喂给摘要模型前预处理)。
 * stripHtml 会把 <bbs_start>…</bbs_start> 整段删掉(含内部时间),摘要模型就看不到时间了;
 * 故先转成「(起始时间:X)/(结束时间:X)」纯文本,再交给 stripHtml 清其余标签。
 */
export function inlineTimeTags(mes: string): string {
  return String(mes ?? '')
    .replace(RE_START, (_, t) => `(起始时间:${String(t).trim()})`)
    .replace(RE_END, (_, t) => `(结束时间:${String(t).trim()})`);
}

/**
 * 把起止时间格式化成展示用的时间段串:
 *  - 都有且不同 → "start - end";都有且相同 → "start";只有一个 → 那一个;都无 → ''。
 */
export function formatRange(start?: string, end?: string): string {
  const a = start?.trim();
  const b = end?.trim();
  if (a && b) return a === b ? a : `${a} - ${b}`;
  return a || b || '';
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
 */
export function syncTimeTagRegex(): void {
  if (apiSettings.timeTagEnabled) ensureHideRegexRegistered();
  else removeHideRegex();
}
