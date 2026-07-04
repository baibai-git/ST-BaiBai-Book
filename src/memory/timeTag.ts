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
import type { LeafExtra } from './types';

/** 标签固定标识(解析正则与隐藏正则都依赖它) */
export const START_TAG = 'bbs_start';
export const END_TAG = 'bbs_end';
/** 物品变动旁注标签:摘要后把本楼物品净变动写进正文 </bbs_end> 之后,供窗口内全文楼层被主模型看到 */
export const ITEMS_TAG = 'bbs_items';
/** 变量变动旁注标签:与 bbs_items 同机制,写本楼自定义变量净变动,供主模型看到「已改过」防重复改 */
export const VARS_TAG = 'bbs_vars';

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
 * 当前「故事内最新时间」:从 chat 末尾往前扫,取第一条解析得到的时间(end 优先,缺则 start)。
 *
 * 为什么不直接用派生的 memory.state.time:那个只重放「已生成叶子」的楼层,最新几层没摘时就停在旧值。
 * 而最新 AI 楼正文里本就带 <bbs_end>,这里直接读它,无论摘没摘都拿到真实最新时间。
 *
 * 取值优先级(每条消息):① 正文 <bbs_start>/<bbs_end> 标签(最权威,不受是否已摘影响);
 *   ② 标签缺失时回退到该楼叶子的 timeEnd/timeStart —— 覆盖「旧聊天补摘」场景:那些楼正文里
 *   没有时间标签(用插件前生成的),但补摘已把时间写进叶子。少了这个兜底,整页相对时间会因
 *   参照点(now)为空而全部不显示。
 * 用途:① 摘要页「当前时间」展示;② 历史摘要注入时相对时间的参照点(「现在」)。
 * 全部解析不到(纯架空/无标签且无叶子)→ 返回空串,调用方各自回退。
 */
export function latestStoryTime(chat: STMessage[] | null): string {
  if (!chat) return '';
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (typeof m?.mes !== 'string' || !m.mes) continue;
    // ① 正文标签优先
    const { start, end } = parseTimeRange(clampToTimeTags(m.mes));
    const tagTime = end || start;
    if (tagTime) return tagTime;
    // ② 标签缺失 → 回退该楼有效叶子的时间(旧聊天补摘:正文无标签但叶子有时间)
    const leaf = m.extra?.bbs_leaf as LeafExtra | undefined;
    if (leaf?.id && leaf.delta && leafSwipeMatches(leaf, m)) {
      const leafTime = leaf.timeEnd?.trim() || leaf.timeStart?.trim();
      if (leafTime) return leafTime;
    }
  }
  return '';
}

/** 叶子页码是否匹配当前 swipe(与 apply.leafValid 同口径;内联避免 timeTag↔apply 循环依赖)。 */
function leafSwipeMatches(leaf: LeafExtra, m: STMessage): boolean {
  const leafSwipe = typeof leaf.swipe === 'number' ? leaf.swipe : 0;
  const msgSwipe = typeof m.swipe_id === 'number' ? m.swipe_id : 0;
  return leafSwipe === msgSwipe;
}

/**
 * 按标签名生成「整块删除」正则(含标签本身与内部内容)。tag 已由 sanitizeTagName 剔除正则元字符,
 * 拼进 RegExp 安全。边界用前瞻 (?=[\s/>]) 而非 \b —— \b 只认 ASCII 词字符,中文标签(如 <雪>)
 * 在 `雪` 与 `>` 之间无词边界会匹配失败;前瞻「标签名后须紧跟空白/斜杠/右括号」对中英文都成立,
 * 且同样防止 <snow> 误吃 <snowball> 前缀。同时删配对块与落单的自闭/单标签。
 */
function blockStripRegexes(tag: string): RegExp[] {
  return [
    new RegExp(`<${tag}(?=[\\s/>])[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), // 配对块
    new RegExp(`<\\/?${tag}(?=[\\s/>])[^>]*\\/?>`, 'gi'), // 落单的开/闭/自闭标签
  ];
}

/** 删掉用户在设置里配置的自定义标签(整块:标签 + 内部内容)。空名单则原样返回。 */
function stripCustomTags(s: string): string {
  let out = s;
  for (const tag of apiSettings.customStripTags) {
    if (!tag) continue;
    for (const re of blockStripRegexes(tag)) out = out.replace(re, '');
  }
  return out;
}

/**
 * 把一段正文清洗成「干净正文段」:剔除正文之外的格式与噪声,但**不做「裸删标签留内容」**——
 * 只整块删除明确的非正文标签(思维链/注释/旧 horae/物品旁注/用户自定义标签),其余原样保留。
 *
 * 两步:
 *  ① 整块删除噪声标签(含内部内容);
 *  ② 裁剪到时间标签区间:取「最后一个 <bbs_start>」+「第一个 </bbs_end>」之间(标签保留)——
 *     思维链/状态栏可能混入同名标签,开始标签取末次、结束标签取首次,精准框出真正的正文段;
 *     仅在对应标签存在时才裁剪,缺标签的一侧保持原样(两侧都没有则不裁,覆盖「旧聊天无标签」场景)。
 *  ③ 规范空白。
 *
 * 注:历史上这里之后还跟一道 stripHtml 做「删所有标签留内容」,反而把自定义标签删没、令整块清洗失效;
 * 现已废弃 stripHtml,改为只整块删、保留其余标签原文(主/副模型都能消化残留标签)。
 */
// 思维链块正则(配对块,含内部内容)。供 clampToTimeTags 与入库前预清洗共用,避免两处漂移。
const RE_THINK_BLOCK = /<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi;

/**
 * 只剥思维链 <think>/<thinking> 块(含内部内容)。
 * 用于向量库**入库前**预清洗:思维链是确定性噪声(不依赖任何用户配置),
 * 入库时删掉既省空间又零风险;而自定义标签等「可变配置」的清洗仍留到召回时做(才能让改设置即时生效)。
 */
export function stripThinkBlocks(mes: string): string {
  return String(mes ?? '').replace(RE_THINK_BLOCK, '');
}

export function clampToTimeTags(mes: string): string {
  let s = String(mes ?? '')
    .replace(RE_THINK_BLOCK, '') // 思维链
    .replace(/<!--[\s\S]+?-->/g, '') // HTML 注释
    .replace(/<horae[\s\S]*?>[\s\S]*?<\/horae[\s\S]*?>/gi, '') // 旧 horae 格式
    .replace(RE_ITEMS_BLOCK, '') // 物品变动旁注(插件写进正文,不该进摘要/索引)
    .replace(RE_VARS_BLOCK, ''); // 变量变动旁注(同上)
  s = stripCustomTags(s); // 用户自定义标签

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
  // 规范空白(原由 stripHtml 负责,现内置)
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 统一正文清洗入口(替代旧的 stripHtml 链路):裁剪正文段 → 把时间标签转可读文本。
 * 摘要生成、世界书扫描、向量召回注入全部走它,保证口径一致;不再「裸删标签」,残留标签原样保留。
 */
export function cleanBody(mes: string): string {
  return inlineTimeTags(clampToTimeTags(mes));
}

/**
 * 把正文里的时间标签转成可读内联文本(cleanBody 的最后一步)。
 * 时间标签 <bbs_start>…</bbs_start> 不在「整块删除」之列,但其尖括号形态对模型不友好,
 * 故转成「(起始时间:X)/(结束时间:X)」纯文本,保留时间信息又去掉标签外形。
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

// 物品变动块:删旧用(整段,含标签)
const RE_ITEMS_BLOCK = new RegExp(`\\n*<${ITEMS_TAG}\\b[^>]*>[\\s\\S]*?</${ITEMS_TAG}>`, 'gi');

// 定位「最后一个 </bbs_end>」用(全局扫,取末次):正文末尾的时间标签才是真正的剧情结束,
// 思维链/状态栏可能在前面混入同名标签,故不能用第一个(见 clampToTimeTags 同款考量)。
const RE_END_CLOSE_G = new RegExp(`</${END_TAG}>`, 'gi');

/**
 * 把物品变动旁注写进正文:先删掉旧的 <bbs_items> 块(幂等,重摘/重生成不叠加),
 * 再把新块插到**最后一个** </bbs_end> 之后(无 end 标签则追加到末尾)。
 * inline 为空 → 只清除旧块、不写新块(本楼无物品变动时)。
 * 返回处理后的正文(调用方负责写回 mes)。
 */
export function writeItemLogTag(mes: string, inline: string): string {
  let s = String(mes ?? '').replace(RE_ITEMS_BLOCK, '');
  const text = inline.trim();
  if (!text) return s;
  // 标签与内容各自独占行,块前留空行,排版清爽且不与时间标签粘连
  const block = `<${ITEMS_TAG}>\n${text}\n</${ITEMS_TAG}>`;
  // 取最后一个 </bbs_end> 的结束位置
  let lastEnd = -1;
  RE_END_CLOSE_G.lastIndex = 0;
  for (let m = RE_END_CLOSE_G.exec(s); m; m = RE_END_CLOSE_G.exec(s)) lastEnd = m.index + m[0].length;
  if (lastEnd >= 0) {
    return `${s.slice(0, lastEnd)}\n${block}${s.slice(lastEnd)}`;
  }
  return `${s.trimEnd()}\n${block}`;
}

// 提取 <bbs_items> 块内文本用
const RE_ITEMS_INNER = new RegExp(`<${ITEMS_TAG}\\b[^>]*>([\\s\\S]*?)</${ITEMS_TAG}>`, 'i');

/**
 * 读取正文里的 <bbs_items> 块内文本(去首尾空白)。
 * 无块返回 null(区别于「有块但空」——后者返回 ''),供反解析判断用户是否删了整块。
 */
export function readItemsTagText(mes: string): string | null {
  const m = String(mes ?? '').match(RE_ITEMS_INNER);
  return m ? m[1].trim() : null;
}

// 变量变动块:删旧用(整段,含标签)
const RE_VARS_BLOCK = new RegExp(`\\n*<${VARS_TAG}\\b[^>]*>[\\s\\S]*?</${VARS_TAG}>`, 'gi');
// 定位物品块结束位置用(变量块紧随物品块之后):取末次
const RE_ITEMS_CLOSE_G = new RegExp(`</${ITEMS_TAG}>`, 'gi');

/**
 * 把变量变动旁注写进正文:先删旧 <bbs_vars> 块(幂等),再插到**物品块之后**(无物品块则最后一个 </bbs_end> 之后,
 * 再无则追加末尾)。与 writeItemLogTag 同款,只是插入锚点优先物品块,让 items/vars 两块相邻、排版稳定。
 * inline 为空 → 只清旧块不写新块。返回处理后的正文。
 */
export function writeVarLogTag(mes: string, inline: string): string {
  const s = String(mes ?? '').replace(RE_VARS_BLOCK, '');
  const text = inline.trim();
  if (!text) return s;
  const block = `<${VARS_TAG}>\n${text}\n</${VARS_TAG}>`;
  // 锚点优先:最后一个 </bbs_items> 结束位置;否则最后一个 </bbs_end>;都无则追加末尾
  const lastOf = (re: RegExp): number => {
    let last = -1;
    re.lastIndex = 0;
    for (let m = re.exec(s); m; m = re.exec(s)) last = m.index + m[0].length;
    return last;
  };
  const anchor = lastOf(RE_ITEMS_CLOSE_G);
  const pos = anchor >= 0 ? anchor : lastOf(RE_END_CLOSE_G);
  if (pos >= 0) return `${s.slice(0, pos)}\n${block}${s.slice(pos)}`;
  return `${s.trimEnd()}\n${block}`;
}

// 提取 <bbs_vars> 块内文本用
const RE_VARS_INNER = new RegExp(`<${VARS_TAG}\\b[^>]*>([\\s\\S]*?)</${VARS_TAG}>`, 'i');

/** 读取正文里的 <bbs_vars> 块内文本(去首尾空白);无块返回 null(供反解析判断用户是否删了整块)。 */
export function readVarsTagText(mes: string): string | null {
  const m = String(mes ?? '').match(RE_VARS_INNER);
  return m ? m[1].trim() : null;
}

/* ============ 自动注册「仅显示层隐藏」正则到 ST ============ */

// ST 全局正则脚本存在 extension_settings.regex(数组)。我们用固定 id 标识自己这条,做到幂等。
// id 保持历史值 'bbs-time-tag-hide' 不变(改 id 会导致老用户旧正则残留 + 新建一条重复);
// 显示名已更新——这条正则如今同时隐藏时间标签与物品变动标签。
const HIDE_SCRIPT_ID = 'bbs-time-tag-hide';
const HIDE_SCRIPT_NAME = '柏宝书 · 隐藏记忆标签';
// regex_placement(见 ST regex/engine.js):0=MD_DISPLAY 1=USER_INPUT 2=AI_OUTPUT
const PLACEMENT_MD_DISPLAY = 0;
const PLACEMENT_USER_INPUT = 1;
const PLACEMENT_AI_OUTPUT = 2;

/** 一条同时吃掉 start/end/items/vars 标签(含其内部内容)的正则字符串(ST 用 /pattern/flags 形式) */
function hideFindRegex(): string {
  const tags = `${START_TAG}|${END_TAG}|${ITEMS_TAG}|${VARS_TAG}`;
  return `/<\\/?(?:${tags})\\b[^>]*>(?:[\\s\\S]*?<\\/(?:${tags})>)?/gi`;
}

/**
 * 确保 ST 里存在我们的「隐藏记忆标签」正则脚本(隐藏时间标签 + 物品变动标签,仅影响显示,不影响提示词)。
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
