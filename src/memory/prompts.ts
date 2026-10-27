/**
 * 提示词模板。
 *
 * 设计要点(相对 Horae 原版的改进):
 *  1. 输出 JSON 而非纯文本,便于结构化抽取与增量更新。
 *  2. 明确区分两类语义:
 *     - 覆盖型(time/location):写当前最新值,代码直接替换。
 *     - 指令型(items/plans):只给「变化」,代码增量施加,省 token 且不易篡改全量。
 *  3. 把「当前状态」(现有物品名、未了结的计划/悬念并编号)注入提示词,
 *     模型才能正确决定 add/remove/update/resolve。
 *  4. 保留 Horae 的优点:时间锚定、具象化、保留专有名词、正文不含 markdown。
 *
 * 占位符:{{user}} {{char}} {{state_time}} {{state_location}}
 *         {{protagonist_block}} {{items_block}} {{plans_block}} {{content}}
 */

import { apiSettings, type Verbosity } from '@/api/settings';
import { fmtLifeDetail } from './lifeDetails';
import { fmtKnowledgeForSummary } from './knowledge';
import { fmtNpcSummaryList, type NpcSummaryView } from './npcRelations';
import { RULE_COMPLETE_TIME_ANCHOR } from './timeTag';
// 新提示词正文以原版文本文件为准(?raw 内联,可原样保留排版与标签)。
import summaryRaw from './prompts/summary.txt?raw';
import resummaryRaw from './prompts/resummary.txt?raw';
import resummary2Raw from './prompts/resummary2.txt?raw';
import tasksRaw from './prompts/tasks.txt?raw';
import builtinProtocolsRaw from './prompts/builtin-protocols.txt?raw';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';
import type { ItemLogEntry, JsonValue, MemKnowledge, MemLifeDetail, MemPlan, MemProtagonist, PlanOutcome, SceneFocus } from './types';

/** 按「===== NAME =====」分节解析协议文件(08)。 */
function protocolSections(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^=====\s*(.+?)\s*=====\s*$/gm;
  const marks: { name: string; headerStart: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) marks.push({ name: m[1].trim(), headerStart: m.index, contentStart: re.lastIndex });
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].headerStart : raw.length;
    out[mark.name] = raw.slice(mark.contentStart, end).trim();
  });
  return out;
}
const PROTOCOLS = protocolSections(builtinProtocolsRaw);
/** 取以 prefix 开头的分节(节名可能带括号说明)。 */
function protocolSection(prefix: string): string {
  const key = Object.keys(PROTOCOLS).find(k => k.startsWith(prefix));
  return key ? PROTOCOLS[key] : '';
}
/** 拆出「规则 / 材料 / 输出协议」三段:材料从 `【主角】{{user}}` 开始,协议从 `【检查记录与最终结果输出协议】` 开始。 */
function splitPrompt(raw: string): { rules: string; input: string; protocol: string } {
  const i = raw.indexOf('【主角】{{user}}');
  const j = raw.indexOf('【检查记录与最终结果输出协议】', i >= 0 ? i : 0);
  return {
    rules: (i >= 0 ? raw.slice(0, i) : raw).trim(),
    input: (i >= 0 ? raw.slice(i, j >= 0 ? j : undefined) : '').trim(),
    protocol: (j >= 0 ? raw.slice(j) : '').trim(),
  };
}
/** 截取内置模板中 [start, end) 之间的规则段;标记缺失返回空串(测试会兜住)。 */
function sliceSection(raw: string, start: string, end: string): string {
  const i = raw.indexOf(start);
  const j = i >= 0 ? raw.indexOf(end, i) : -1;
  return i >= 0 && j > i ? raw.slice(i, j).trim() : '';
}
/** 去掉 NVWA 核心,只留任务说明部分。 */
function afterStandaloneCore(raw: string): string {
  const tag = '</nvwa_standalone_core>';
  const i = raw.indexOf(tag);
  return (i >= 0 ? raw.slice(i + tag.length) : raw).trim();
}
/** 去掉独立核心:核心统一放在「破限」位(JAILBREAK_PROMPT)。
 *  正文提示词不再重复携带,避免同一请求里核心出现两次、也避免看起来「破限被拆散」。 */
const SUMMARY_BODY = afterStandaloneCore(summaryRaw);
const RESUMMARY_BODY = afterStandaloneCore(resummaryRaw);
const RESUMMARY2_BODY = afterStandaloneCore(resummary2Raw);

const SUMMARY_SPLIT = splitPrompt(SUMMARY_BODY);
const RESUMMARY_SPLIT = splitPrompt(RESUMMARY_BODY);
const RESUMMARY2_SPLIT = splitPrompt(RESUMMARY2_BODY);

/** 旁注读取协议(注入主对话,提醒主模型不要复写 <bbs_items>/<bbs_vars>)。 */
export const LEDGER_PROTOCOL = protocolSection('LEDGER_PROTOCOL');

/** 一个可用占位符(宏):token 用于插入,desc 给用户看「这里会替换成什么」。 */
export interface PromptMacro {
  token: string;
  desc: string;
}

/** 摘要提示词可用的宏(供设置页展示 + 点击插入) */
export const SUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{history_block}}', desc: '本轮之前的历史剧情摘要' },
  { token: '{{state_time}}', desc: '当前已知时间' },
  { token: '{{state_location}}', desc: '当前已知地点' },
  { token: '{{protagonist_block}}', desc: '主角当前客观档案' },
  { token: '{{items_block}}', desc: '现有物品清单' },
  { token: '{{itemlog_block}}', desc: '近期物品变动(已结算的账)' },
  { token: '{{scenes_block}}', desc: '已知地点清单(避免重复记录)' },
  { token: '{{npcs_block}}', desc: '已登场的 NPC 名册(避免重复记录)' },
  { token: '{{plans_block}}', desc: '未了结的计划/悬念' },
  { token: '{{resolved_plans_block}}', desc: '近期已了结的计划/悬念(含了结方式/原因,防重复记录)' },
  { token: '{{scenefocus_block}}', desc: '本轮在场/即时场景与未完成动作(按需更新)' },
  { token: '{{vars_state_block}}', desc: '自定义变量当前状态 + 含义 + 变化规则(未配置时为空)' },
  { token: '{{varlog_block}}', desc: '变量含义 + 变化规则(合并)' },
  { token: '{{content}}', desc: '本轮待摘要的对话正文' },
  { token: '{{summary_words}}', desc: '摘要目标字数范围(随详细/精简档位变化)' },
  { token: '{{summary_max_chars}}', desc: '摘要字符上限(硬上限,随档位变化)' },
];

/** 总结(压缩)提示词可用的宏 */
export const RESUMMARY_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{content}}', desc: '待融合的多条摘要正文' },
  { token: '{{resummary_words}}', desc: '总结目标字数范围(随详细/精简档位变化)' },
];

/** 二次总结提示词可用的宏(动态字数区间随详细/精简档位变化) */
export const RESUMMARY2_MACROS: PromptMacro[] = [
  { token: '{{user}}', desc: '主角名' },
  { token: '{{char}}', desc: '角色名' },
  { token: '{{content}}', desc: '待融合的多条上层总结正文' },
  { token: '{{target_min}}', desc: '最低字数(详细为输入的 40%,精简为 30%)' },
  { token: '{{target_max}}', desc: '最高字数(详细为输入的 50%,精简为 40%)' },
  { token: '{{target}}', desc: '兼容旧自定义模板:等同于最高字数 {{target_max}}' },
];

/**
 * 记忆注入块的「私密简报」框定语:贴在每个注入回主对话的记忆块开头。
 * 为何需要:[当前状态]/[历史剧情摘要]/[相关回忆] 长得像数据面板,主模型容易误以为是
 * 要它填写/复述的模板,于是在正文后跟着输出一份状态快照。这句明确「只读、仅你可见、
 * 严禁复述」,把它们框定为幕后背景而非待输出内容。(时间标签提示词是真要模型输出标签的
 * 指令,不套这层框定。)
 */
export const MEMORY_BRIEFING_NOTE = protocolSection('MEMORY_BRIEFING_NOTE');

/**
 * 简报收尾:与 NOTE 首尾包裹,把记忆块明确「封口」,避免主模型把后续正文也当成简报的一部分续写。
 * 末句给正向引导——不只是「别复述」的禁令,而是「像已读过前情的叙述者那样自然续写」,告诉模型
 * 简报的用途是「我已知道这些」,正文里自然体现即可。
 */
export const MEMORY_BRIEFING_END = protocolSection('MEMORY_BRIEFING_END');

/* ============ 共享规则段:内置模板经宏插入、自定义模板缺失时作兼容补充;summary.txt 原文自带的段直接截取,单一来源避免分叉 ============ */

/** 用户操控主角的客观当前档案规则。截自 summary.txt:手抄版曾落后内置(缺伤势证据、旧伤照抄),自定义模板一直在用旧口径。 */
export const RULE_PROTAGONIST = sliceSection(SUMMARY_SPLIT.rules, '═══ 【主角当前档案规则】', '═══ 【物品规则】');

/**
 * 只对 NPC 好感字段开放估算,不放宽事实摘要/关系/主角档案的证据边界。
 * 截自 summary.txt:档位行写死在文件里,须与 NPC_AFFINITY_FIELDS 一致(npcAffinity 测试兜住)。
 */
export const RULE_NPC_AFFINITY = sliceSection(SUMMARY_SPLIT.rules, '═══ 【内心好感与外在态度规则】', '═══ 【计划/悬念规则】');

/** 互动局势卡规则(sceneFocus 字段)。截到宏行为止:其后的生活小档案等规则由各自的兼容协议另补。 */
export const RULE_SCENE_FOCUS = sliceSection(SUMMARY_SPLIT.rules, '═══ 【互动局势卡规则】', '{{lifedetails_rule}}');

/** 生活小档案规则(lifeDetails 字段)。 */
export const RULE_LIFE_DETAILS = `═══ 【生活小档案规则】(lifeDetails 字段,极严筛选) ═══
记录**主角及主要角色**的偏好/习惯/近期个人状态,帮写作 AI 在相关时自然贴合;不扩展到路人或一次性配角。
【所属人物必填】每条 add 必须带 subject:主角固定写字面值 "user"(不是主角姓名),主要角色写 NPC 名册中的确切名字(含本楼按 NPC 规则新增/标记 important 的主要角色)。一条只属于一个人,多人相同习惯分开记录。text 写该人物的具体细节,展示时系统会补上姓名;把“我/他/她”解析成明确所属人物,不把说话者、被谈论者或 user 混为一人。主语不明宁可不记。
【铁律:只认本人明确陈述、或正文明确揭示的事实】禁止从行为/语气推断偏好与内心;一次吃了煎饼不等于爱吃煎饼。引语、转述、玩笑、反讽或猜测不能直接当成该人物的真实习惯;没有可靠明文依据不记。好感与态度估计不写这里。
【默认不记】先对照材料中的【生活小档案】按“同一人物 + 同义内容”查重,已有条目不重复 add;不同人物即使文字相同也不合并。旧条目缺 subject 仅按旧协议视为主角,不要自行改判成某个 NPC。
【add】topics 填 1-3 个主题标签(饮食/作息/工作…),anchors 填原文可检索的关键词(香菜/项目…),供系统按相关性投放;until 填故事内到期时间表示有时效(如项目结束日),长期稳定偏好 until 留空。
【update/archive/remove】用编号 d1、d2… 指代该列表,先核对所属人物:
  ✦ 条目被正文明确推翻/纠正 → update 改 text;只有明确记错归属时才改 subject,省略 subject=保持原人物;
  ✦ 时效已过/不再相关 → archive(沉降为仅触发,不是删除);
  ✦ 记错了 → remove。拿不准不动,不能用另一个人的偏好覆盖本人的条目。
【分工】饮食、作息等生活细节归这里;身份/外貌/当前着装/健康状态仍归 protagonist 或 npcs,不要重复记录。这里只放值得跨场景保留的细节,不是每轮流水账。
【克制】这些细节仅作相关人物的写作参考,不是写作任务;严禁在 summary 里逐条罗列,不得把某人的习惯套给别人。`;

/** 了解清单规则(knowledge 字段)。不用 {{user}}:规则作为宏值插入,不会再展开一遍。 */
export const RULE_KNOWLEDGE = `═══ 【了解清单规则】(knowledge 字段) ═══
记录**每个 NPC 目前知道/以为的关于主角的事**。写作 AI 会把它当作角色的「知情范围」:清单里没有的主角私事,该角色默认不知道,以此防止角色凭人设或世界书全知主角。只记角色对主角,不记角色之间;好感与态度仍归 npcs。
【来源铁律】只记该角色本轮**亲耳听到、亲眼看到、或听别人告诉**的:主角当面说的、当着其面做的、第三人转告的。主角的内心独白、旁白叙述、该角色不在场时发生的事一律不算——该角色并不知道。
【记角色以为的,不是真相】把握程度写进句子开头:认定…/怀疑…/听说…/主角自称…。角色被骗就照记被骗后的认知(主角谎称是商人 → "认定主角是行商"),不注明真相;日后被揭穿,用 update 改写原条(如"得知主角其实是王子,此前一直被瞒"),不要另加一条矛盾的。
【记什么】主角的名字(角色第一次得知时记)、身世、过往经历、秘密、私人喜好与习惯、主角自称或刻意隐瞒的身份。外貌、当场可见的举动、公开身份人人看得到,不必记;一次性琐事不记。
【查重】先对照材料里的「角色对主角的了解」列表,按"同一角色 + 同义内容"查重;已有的不重复 add,认知加深或改变用 update 改原条。
【add】who 写 NPC 名册中(含本楼 npcs.add 新登场)的确切名字,不能是主角;名册里没有的角色不记。text 一句话只写一件事。
【update/remove】用该列表的编号 k1、k2… 指代:认知被纠正/加深 → update 改 text;记错了(该角色其实不知道/记到了别人头上)→ remove。拿不准不动。`;

/**
 * 自定义变量规则(vars 字段,路径命令)。仅当用户配置了变量(有当前状态或说明)时才注入(见 {{vars_rule}})。
 * 变量是一棵 JSON 状态树,AI 用 set/assign/remove/add 按路径自由增删改,可在【说明】约定下新建对象/字段。
 */
export const RULE_VARS = `═══ 【自定义变量规则】(vars 字段,路径命令) ═══
材料中的【自定义变量·当前状态】是一棵 JSON 状态树(结算到此刻);【变量含义】告诉你每个字段是什么;【变量变化规则】告诉你何时怎么变、可否新建。
当本回合正文里发生了明确、具体的事件、导致状态该变时,在 vars 字段输出一个**命令数组**去修改它。每条命令是一个对象:
  · 赋值/覆盖:{ "op":"set", "path":"路径", "value":新值 }
  · 数字增减:{ "op":"add", "path":"路径", "delta":增量 }(delta 可负,如 -10)
  · 往对象/数组里加(含**新建对象**):{ "op":"assign", "path":"父路径", "key":"新键", "value":值 };往数组末尾追加则省略 key
  · 删除:{ "op":"remove", "path":"路径", "key":"要删的键/下标/值" };删整个节点则省略 key、path 指向它
【路径】用点和方括号寻址:"势力.魔法议会.声望"、"队伍[0].hp"。父路径上缺失的中间层会自动创建。
【自由创建(重点)】允许你按剧情**新建**状态树里还没有的字段/对象——例如遇到一个新势力,用 assign 在「势力」下加一个对象(键=势力名,值=含各属性的对象),遵循【变量变化规则】里的约定。
【只改真正变的 · 防重复结算】当前状态已是结算到此刻的值。只对正文里**新发生**的事件发命令;没变的别发;上一段已经算过的账(如已 +5)本段无新事件就别再动。
【克制】不确定、纯推测、正文没提 → 不发命令。宁可少发,命令要准。无任何变化时,vars 直接省略或给空数组。`;

/**
 * 摘要正文的时间语言铁律。所有摘要层级共用;自定义模板没带此段时在构造时补上,
 * 带了就以模板为准——旧模板多自带旧版,再补新版会两版口径并存。
 * 相对时间在生成当下可能正确,但存进长期记忆后会随「现在」移动而失真,故入库前就绝对化。
 * 直接截自 summary.txt:内置与自定义补充若各写一版,口径迟早打架。
 */
export const RULE_ABSOLUTE_TIME_LANGUAGE = sliceSection(SUMMARY_SPLIT.rules, '═══ 【摘要时间语言铁律】', '【状态核对】');

/** 检查记录与最终数据分离;各级摘要及自定义模板共用同一输出约定。 */
export const SUMMARY_OUTPUT_PROTOCOL = SUMMARY_SPLIT.protocol;

/**
 * 关系线保留:L0 摘要与两级压缩共用。
 *
 * 慢热关系由一串高度相似的可见小互动构成,而压缩规则天然视“同类重复”为噪声——
 * 若不单独声明,这条线会在 L1/L2 被合并删除,主模型与状态字段都拿不到“最近在往哪走”的趋势。
 * 本规则只要求保留可观察事实,不放开任何心理/关系结论的推断门槛(证据边界仍在各任务规则里)。
 * 同样截自 summary.txt,自定义模板补上的与内置是同一份。
 */
export const RULE_RELATION_MOMENTUM = sliceSection(SUMMARY_SPLIT.rules, '═══ 【关系线保留】', '【摘要成文顺序】');

/**
 * 摘要撰写段(撰写规则 → 关系线 → 成文顺序 → 压缩保真 → 表达示范 → 时间铁律),截自 summary.txt 给批量复用,
 * 免得批量另养一套旧版写作规则。该段因此须与字段无关:单楼专属的字段核对放在其后的【状态核对】。
 */
const SUMMARY_WRITING_RULES = sliceSection(SUMMARY_SPLIT.rules, '═══ 【摘要撰写规则】', '【状态核对】');

const SUMMARY_INPUT = SUMMARY_SPLIT.input;

const SUMMARY_RULES = SUMMARY_SPLIT.rules;

/** 设置页仍提供完整可编辑模板;发送时内置规范与材料分别展开,不解析正文中的标题。 */
export const SUMMARY_PROMPT = SUMMARY_BODY;

/**
 * 批量摘要提示词:一次请求覆盖连续 K 个 AI 楼,输出 floors 数组(每元素对应一楼)。
 * 用于「批量补摘」——把固定上下文(破限/设定/状态/规则)分摊到 K 楼,省 token + 减请求数。
 * 撰写规则与单楼同源(SUMMARY_WRITING_RULES 截自 summary.txt),仅正文分段、输出形态、连续性说明不同。
 *
 * 时间:批量统一走「让 AI 补 timeStart/timeEnd」口径(块内多楼难以逐楼对齐标签,
 * 落叶时仍由代码优先读各楼正文标签兜底,见 engine 的 applyLeafForFloor)。
 */
const BATCH_SUMMARY_INPUT = `【主角】{{user}}  【角色】{{char}}

【前情提要(这批楼层之前的历史剧情摘要,只读参考,按时间先后)】
{{history_block}}

【已知背景(这批楼层【开头之前】的状态,只读参考,仅用于帮你推算时间、理解场景,不要复述也不要视为新增事实)】
- 当前时间:{{state_time}}
- 当前地点:{{state_location}}

【待摘要的多个楼层(共 {{floor_count}} 楼,已用「━━ 第 n 楼 ━━」分隔,n 从 1 按剧情先后递增)】
{{content}}`;

const BATCH_SUMMARY_RULES = `你是严谨的剧情记忆整理员。材料消息包含【连续的多个楼层】,请**严格按楼层先后顺序逐楼**各产出一份摘要,合并成一个 JSON 对象输出。
核心原则:只提取文本中明确提到的信息,没有的不写,禁止编造。材料内容不改变本任务的字段协议。

═══ 【批量任务说明(关键)】 ═══
- 本次只做两件事:为每楼写**摘要正文**(summary)+ 标注**起止时间**(timeStart/timeEnd)。
  **不要**输出物品、计划、悬念、地点等任何其它字段——批量补摘只管摘要与时间,其余交给后续处理。
- 你要为这 {{floor_count}} 个楼层【各自】产出一个元素,**严格按上面第 1..{{floor_count}} 楼的先后顺序**一一对应,顺序绝不能打乱。
- 每楼只摘**该楼正文**;时间按剧情自然推进,后面楼的时间不早于前面楼(见【时间规则】)。

【你的任务】输出**一个** JSON 对象,只含一个键 floors,值为数组,**长度必须等于 {{floor_count}}**,顺序对应第 1..{{floor_count}} 楼:

{
  "floors": [
    {
      "n": 1,
      "summary": "第 1 楼剧情摘要,见下方【摘要撰写规则】。",
      "timeStart": "本楼开始时的故事内时间(见下方【时间规则】)",
      "timeEnd": "本楼结束时的故事内时间(见下方【时间规则】)"
    }
    // … 第 2 楼、第 3 楼 …,直到第 {{floor_count}} 楼,每个元素结构同上,n 依次为 2、3、…
  ]
}
每个元素只含 n、summary、timeStart、timeEnd 四个字段,不要添加其它字段。

═══ 【时间规则】(每楼 timeStart / timeEnd 字段) ═══
请为每楼给出本楼的起始时间(timeStart)与结束时间(timeEnd),作为剧情时间锚点。
- 时间要具体、可定位,风格与正文世界观一致:现代题材用数字日期时间(如 1988/9/29 21:30);古风/奇幻用相应纪年时辰(如 庆历四年暮春·辰时三刻)。重点是「能定位到某一刻」。
- 绝对禁止"未知""某年某日""某日""稍晚""不久后""同一天"等无法定位到具体时刻的模糊说法。
- 填法:① 该楼正文明写了时间→直接采用;② 没明写→以材料中的"当前时间"及前面各楼推进为基准,结合本楼剧情流逝(对话约几分钟、用餐约一小时、过夜跨到次日等)推算出具体时间;③ 全无依据→自行设定一个符合世界观的合理起点。
- **允许且要求合理推测**:据上下文推算出一个具体时间,属于基于剧情的合理设定,**不算编造**;宁可给一个不完美但具体的时间,也绝不能留空或写模糊词。这是建立时间锚点所必需。
- **时间必须单调递增**:第 n 楼的时间不得早于第 n-1 楼;若某楼时间没推进,timeStart 与 timeEnd 写同值即可。
- 这两个锚点字段不受【摘要时间语言铁律】“叙述不补年份、分钟”的限制;summary 里仍只写有依据的时间。

${RULE_COMPLETE_TIME_ANCHOR}

${SUMMARY_WRITING_RULES}

【输出铁律】
- 检查记录之后的最终 JSON 根键只有 floors;floors 长度严格等于 {{floor_count}},n 从 1 连续到 {{floor_count}},不可缺楼、不可多楼、不可乱序。
- 每个元素只含 n / summary / timeStart / timeEnd,不要输出 items / plans / location 等字段。`;

export const BATCH_SUMMARY_PROMPT = `${BATCH_SUMMARY_RULES}\n\n${BATCH_SUMMARY_INPUT}\n\n${SUMMARY_OUTPUT_PROTOCOL}`;

/**
 * 批量摘要的思考清单(压在 user 之后)。保留逐楼对齐与时间检查,
 * 取舍/复核要点与单楼清单同口径,不引入单楼的物品/NPC 等状态更新盘点。
 */
export const BATCH_THINKING_CHECKLIST = `【输出前思考(逐楼核查)】
${SUMMARY_OUTPUT_PROTOCOL}
在同一个检查块内按楼层顺序完成以下检查,全部完成后闭合检查块再输出 JSON:
1. 逐楼定位:这批共 {{floor_count}} 楼,我将**严格按先后顺序**为每楼产出一个数组元素,n 依次 1..{{floor_count}},不漏、不重、不乱序。
2. 时间单调且完整:每楼标起止时间,后一楼不早于前一楼;无依据则按剧情流逝合理推算。现代/数字日期的两端都必须包含完整年份,不得缩写成月日或单独时刻。
3. 收笔:每楼 summary 止步于该楼正文最后一个明文动作,不续写、不跨入下一楼。
4. 只产摘要+时间:每个元素只含 n / summary / timeStart / timeEnd,不输出物品、计划、地点等字段。

每楼以「第 n 楼」简记关键取舍或修正,依次核对以下要点,不重复抄写正文。前面楼只作历史参考,不得借后面楼补齐当前楼的结论。正文的 [M消息序号-P段序号] 只供定位,不等于结果的 n。
【摘要取舍】
- 每楼只摘该楼正文;前情与背景只作核对,不当作该楼新事件。先留改变行动方向的决定、关键结果、尚有效的限制及关系互动,再补必要前因与可用情报;核心互动与关键台词、明写的情绪、新情报与结果、伏笔按【摘要撰写规则】保留,原文没有的不凑。
- 按完整命题保留主体、来源、条件、对象、后果及时间范围,关键数值与比较基准不丢;区分建议、已决定、已启动与已完成。不让旧状态冒充现状,冲突保留分歧。
【摘要复核】
- 回源对词:对照该楼原文查条件与后果是否仍逐条对应,主体、来源、否定、程度、时段和方位是否保留原限定;并列事实没有被补成关联,段时间没有换成旧时点。
- 了结写清实际结果,不把意图写成完成、把互动写成关系结论;再删没有结果的检查收纳与重复过程,不删重要参数、有效伤势及关系互动。

核查完所有楼后闭合 </thinking>,再输出 JSON 对象(根键 floors),无 markdown 围栏、无额外解释。`;

/**
 * 时间规则有两种形态,由「被分析正文是否带 <bbs_start>/<bbs_end> 时间标签」决定:
 *  - 有标签:时间由插件从标签直读(权威锚点),AI 不必再算 → 省 time 字段。
 *  - 无标签(多为开篇/老对话):让 AI 补出 timeStart/timeEnd 两端,作为锚点兜底。
 * buildSummaryPrompt 据此填充 {{time_field}}(JSON 模板里的字段说明)与 {{time_rule}}(规则段)。
 */
export const TIME_FIELD_WITH_TAGS = `  // 时间已由正文标签提供,无需输出 time 字段`;
export const TIME_RULE_WITH_TAGS = `═══ 【时间规则】 ═══
本轮正文已带时间标签,故事内时间由系统自动读取,你**无需输出 time / timeStart / timeEnd 字段**。检查期限时直接采用本楼结束时间,不得重新推算已有的时间锚点。`;

export const TIME_FIELD_NO_TAGS = `  "timeStart": "本段开始时的故事内时间,见下方【时间规则】。",
  "timeEnd": "本段结束时的故事内时间,见下方【时间规则】。",`;
export const TIME_RULE_NO_TAGS = `═══ 【时间规则】(timeStart / timeEnd 字段) ═══
本轮正文没有时间标签,请你给出本段的起始时间(timeStart)与结束时间(timeEnd)两个值,作为剧情的时间锚点。
- 时间要具体、可明确定位,风格与正文世界观一致:现代题材用数字日期时间(如 1988/9/29 21:30);古风/奇幻题材用相应纪年与时辰(如 庆历四年暮春·辰时三刻)。重点是「能定位到某一刻」,不强求阿拉伯数字。
- 绝对禁止"未知""某日""稍晚""不久后""同一天"等无法定位到具体时刻的模糊说法。
- 填法优先级:① 正文明写了时间→直接采用;② 正文没明写→以材料中的"当前时间"为基准,结合本回合剧情流逝(对话约几分钟、用餐约一小时、过夜跨到次日等)推算;③ 连参考状态都没时间→自行设定一个符合世界观的合理起点。
- 这是为剧情建立时间锚点所必需,属于基于上下文的合理设定,不算编造;宁可给一个不完美但具体的时间,也绝不能留空或写模糊词。
- 若本段时间没有推进(起止相同),timeStart 与 timeEnd 写同一个值即可。
- 这两个锚点字段不受【摘要时间语言铁律】“叙述不补年份、分钟”的限制;summary 里仍只写有依据的时间。

${RULE_COMPLETE_TIME_ANCHOR}`;

const RESUMMARY_INPUT = RESUMMARY_SPLIT.input;

const RESUMMARY_RULES = RESUMMARY_SPLIT.rules;

export const RESUMMARY_PROMPT = RESUMMARY_BODY;

/**
 * 二次总结(L1+ → 更上层):把已经压过一轮的多条总结再压一层。
 * 与普通总结的关键差异——篇幅按输入规模动态给预算:详细档参考 40%–50%,
 * 精简档参考 30%–40%;内置模板把下限视为参考、上限视为硬预算,避免为凑字数保留流水细节。
 * 字段输出仍是 { summary }(与普通总结同口径,便于 extractJsonObject 复用)。
 */
const RESUMMARY2_INPUT = RESUMMARY2_SPLIT.input;

const RESUMMARY2_RULES = RESUMMARY2_SPLIT.rules;

export const RESUMMARY2_PROMPT = RESUMMARY2_BODY;

/** 两级压缩沿用摘要的显式检查记录,但不执行物品/NPC 等状态更新。 */
export const RESUMMARY_THINKING_CHECKLIST = protocolSection('RESUMMARY_THINKING_CHECKLIST');

/**
 * 破限提示词默认值:作为置顶 system 附加在摘要/总结请求里,降低副 API 对露骨/暴力内容的拒答率。
 * 用户可在设置里覆盖;留空(清掉)则不附加。摘要任务面对的是已生成的正文,需如实记录而非二次审查。
 * 破限 = 纯 NVWA 独立核心(不含 04 后面那段「记忆整理任务说明」)。作为独立 system 消息置于每个记忆请求最前。
 */
export const JAILBREAK_PROMPT = (() => {
  const close = '</nvwa_standalone_core>';
  const end = tasksRaw.indexOf(close);
  return end >= 0 ? tasksRaw.slice(0, end + close.length).trim() : tasksRaw.trim();
})();

interface BuildArgs {
  user: string;
  char: string;
  time: string;
  location: string;
  /** 用户操控主角的当前客观档案 */
  protagonist: MemProtagonist;
  /** 当前互动局势(上一张局势卡,覆盖到该楼之前;只读参考,null=无) */
  sceneFocus: SceneFocus | null;
  /** 主角及主要角色的生活小档案(当前已记录;供人物核对、查重与 d 序号指代) */
  lifeDetails: MemLifeDetail[];
  /** 相关角色(在场/主要/本轮点名)的了解清单,顺序即 k1/k2…;省略=功能关闭,规则/字段/材料整块不发 */
  knowledge?: MemKnowledge[];
  /** 现有物品名列表 */
  items: { name: string; qty?: number; desc?: string; carried?: boolean; location?: string }[];
  /** 近期物品变动日志(已结算的账,防重复结算用) */
  itemLog: ItemLogEntry[];
  /** 已知地点(完整路径 + 描述,供 AI 复用命名、防重复记录、判断 reparent) */
  scenes: { path: string[]; desc?: string }[];
  /** 已登场 NPC(供 AI 复用命名、防重复记录、判断状态更新) */
  npcs: NpcSummaryView[];
  /** 未了结计划(顺序即编号 p1..pn);createdTime/targetTime 为故事内时间(可空) */
  openPlans: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
  /** 近期已完成的计划/悬念(已按 resolvedAt 倒序取好最近 N 条);防副模型重复记录。空数组→渲染「(无)」 */
  resolvedPlans: MemPlan[];
  /** 本轮之前的历史摘要文本(已选「最高压缩层」节点拼接);空表示无前情 */
  history: string;
  /** 待摘要的正文 */
  content: string;
  /** 正文是否已带 <bbs_start>/<bbs_end> 时间标签:有则时间走标签、提示词省去 time;无则让 AI 补两端 */
  hasTimeTags: boolean;
  /** 自定义变量当前状态(结算到本楼之前的 JSON 树;空对象+空说明=未启用,提示词里整块省略) */
  varsState: Record<string, JsonValue>;
  /** 变量含义(合并三层 meaning):各字段是什么;主/副API都拿到 */
  varsMeaning: string;
  /** 变量变化规则(合并三层 rule):何时怎么改/可否新建;仅副API拿到 */
  varsRule: string;
}

/**
 * 单行化:把值里的换行折叠成空格。名册/物品/地点/计划都是「一条一行、字段内联拼接」的格式,
 * 值内含换行会把一条拆成多行、破坏结构、误导模型。故所有内联字段渲染前都过此函数(trim 拦不住中间换行)。
 */
function oneLine(s: string | undefined): string {
  return (s ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

export function fmtItems(items: BuildArgs['items']): string {
  if (!items.length) return '  (无)';
  return items
    .map(i => {
      const qty = typeof i.qty === 'number' ? ` ×${i.qty}` : '';
      const desc = oneLine(i.desc) ? ` —— ${oneLine(i.desc)}` : '';
      // 随身/存放地标注:随身(默认)不标,非随身标 [存:地点],让 AI 知道现状以便正确移动物品
      const place = i.carried === false ? ` [存:${oneLine(i.location) || '某处'}]` : '';
      return `  - ${i.name}${qty}${place}${desc}`;
    })
    .join('\n');
}

/** 主角当前客观档案。字段始终全量展示,不参与 NPC 的在场分档。年龄显示带锚点(勿再重复记录)。 */
export function fmtProtagonist(protagonist: MemProtagonist): string {
  const age = protagonist.age
    ? `${protagonist.age}${protagonist.ageTime ? `(记录于 ${protagonist.ageTime})` : ''}`
    : '';
  const rows: Array<[string, string | undefined]> = [
    ['性别', protagonist.gender],
    ['年龄', age],
    ['身份', protagonist.identity],
    ['外貌', protagonist.appearance],
    ['着装', protagonist.outfit],
    ['状态', protagonist.condition],
  ];
  const lines = rows
    .filter(([, value]) => oneLine(value))
    .map(([label, value]) => `  - ${label}:${oneLine(value)}`);
  return lines.length ? lines.join('\n') : '  (暂无记录)';
}

/**
 * 已知地点树(带层级缩进 + 描述):供 AI 复用命名、避免重复记录、判断 reparent 挂接关系。
 * 按路径字典序排,深度即缩进;每级显示本级名 + 描述。空则「(无)」。
 */
export function fmtScenes(scenes: BuildArgs['scenes']): string {
  if (!scenes.length) return '  (无)';
  // 按完整路径字典序排,保证父级先于子级、同级相邻
  const sorted = [...scenes].sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  return sorted
    .map(s => {
      const depth = Math.max(0, s.path.length - 1);
      const indent = '  '.repeat(depth + 1); // 至少一级缩进对齐其它块
      const name = s.path[s.path.length - 1] ?? '';
      const desc = oneLine(s.desc) ? ` —— ${oneLine(s.desc)}` : '';
      return `${indent}- ${name}${desc}`;
    })
    .join('\n');
}

/**
 * 已登场 NPC 名册:供 AI 复用命名、避免重复记录、判断更新/退场/状态演变。
 * 每条显示 名 + 性别 + 年龄(带记录时点,示意「已记过、勿重复」)+ ★主要 + [随行/所在地] + 身份
 * + 与主角关系 + 与其他角色的长期关系 + 当前即时状态(着装/状态)。
 * 性别在所有分档都发(包括不在场),防 AI 搞错性别;即时状态进名册是有意为之:
 * AI 要据此判断「是否该更新着装」「离场的主要角色该不该推演演变」。
 * 性格/外貌仍不进(够识别复用即可,省 token)。空则「(无)」。
 */
export function fmtNpcs(npcs: BuildArgs['npcs']): string {
  return fmtNpcSummaryList(npcs);
}

/**
 * 把近期物品变动日志格式化成给模型看的列表。
 * 数量变化用 from→to 表达(都已知时);只标方向词(获得/变更/消耗尽)在没有数量时兜底。
 * 空则返回 "(无)"。
 */
export function fmtItemLog(log: ItemLogEntry[]): string {
  if (!log.length) return '  (无)';
  const kindWord = (k: ItemLogEntry['kind']): string =>
    k === 'add' ? '获得' : k === 'remove' ? '移除' : '变更';
  return log
    .map(e => {
      const time = e.time?.trim() ? `${e.time.trim()}:` : '';
      // 数量变化:两端都已知且不同 → from→to;否则只给方向词
      const hasFrom = typeof e.from === 'number';
      const hasTo = typeof e.to === 'number';
      let qty = '';
      if (hasFrom && hasTo && e.from !== e.to) qty = `(${e.from}→${e.to})`;
      else if (!hasFrom && hasTo) qty = `(×${e.to})`;
      else if (hasFrom && !hasTo) qty = `(原×${e.from})`;
      return `  - ${time}${e.name} ${kindWord(e.kind)}${qty}`;
    })
    .join('\n');
}

/**
 * 写进正文 <bbs_items> 旁注用的「动词式」多行格式(一行一物品,每行必带数量)。
 * 动词由数量增减方向决定(不看 kind):to>from→获得、to<from→消耗、清空(to=0)→失去。
 * 数量 = 本次涉及的差额(|to-from|)。一切物品都计数,from 缺省按 0 起算(新物品)。
 * 例:
 *   获得 匕首 1
 *   消耗 解药 1
 *   失去 火把 2
 * 空则返回空串(调用方据此不写块)。
 */
export function fmtItemLogInline(log: ItemLogEntry[]): string {
  if (!log.length) return '';
  const lines: string[] = [];
  for (const e of log) {
    const from = typeof e.from === 'number' ? e.from : 0;
    const to = typeof e.to === 'number' ? e.to : 0;
    const diff = to - from;
    if (diff === 0) continue; // 无数量变化(纯描述更新)不写进旁注
    if (to <= 0) lines.push(`失去 ${e.name} ${from}`); // 清空:失去原有全部
    else if (diff > 0) lines.push(`获得 ${e.name} ${diff}`);
    else lines.push(`消耗 ${e.name} ${-diff}`);
  }
  return lines.join('\n');
}

/* ============ 自定义变量:JSON 状态渲染(注入 / 提示词) ============ */

/** 把当前变量状态 JSON 渲染成可读文本(缩进 JSON)。空对象→「(空)」。 */
export function renderVarsState(json: Record<string, JsonValue>): string {
  if (!json || !Object.keys(json).length) return '(空)';
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return '(无法显示)';
  }
}

/**
 * 选「近期已完成的计划/悬念」:**计划与悬念各取最近 n 条**(分别按 resolvedAt 倒序),再合并。
 * 分类计数的原因:计划(角色主动要做)被了结后最易被 AI 当未完成又去推进 —— 重复风险高;
 * 而悬念(被动未决项)很少被主动重新 add。若混合取 N,一批集中了结的悬念会把计划挤出列表,
 * 恰恰丢掉最该留住的那类。分别取 N 保证两类都有代表、计划一定在。
 * 注入端与副API共用同一选择逻辑 —— 口径一致,只差传入 plans 的截止点
 * (注入用全量 memory.plans;副API用 deriveMemory(chat, beforeIndex).plans)。
 * n<=0 或无已了结项 → 空数组(调用方据此不渲染整块)。最终列表按 resolvedAt 倒序便于阅读。
 */
export function selectRecentResolvedPlans(plans: MemPlan[], n: number): MemPlan[] {
  if (!(n > 0)) return [];
  const resolved = plans.filter(p => p.status === 'resolved');
  const byTimeDesc = (a: MemPlan, b: MemPlan): number => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0);
  const plansTop = resolved.filter(p => p.kind === 'plan').sort(byTimeDesc).slice(0, n);
  const suspenseTop = resolved.filter(p => p.kind === 'suspense').sort(byTimeDesc).slice(0, n);
  return [...plansTop, ...suspenseTop].sort(byTimeDesc);
}

/**
 * 了结方式的中性显示标签(按 kind 措辞,读着自然)。无 outcome(旧数据)→「已了结」。
 * 关键:cancelled 明确显示「已取消/已作废」,不再和 done 混成「已完成」,主模型才不会误判还要做。
 */
export function outcomeLabel(kind: MemPlan['kind'], outcome?: PlanOutcome): string {
  if (kind === 'suspense') {
    return outcome === 'done' ? '已揭晓' : outcome === 'cancelled' ? '已作废' : outcome === 'failed' ? '已落空' : '已了结';
  }
  return outcome === 'done' ? '已达成' : outcome === 'cancelled' ? '已取消' : outcome === 'failed' ? '已失败' : '已了结';
}

/**
 * 渲染「近期已了结的计划/悬念」列表(不编号——它们已了结,无需像未了结项那样供 resolve 指代)。
 * 每条:[计划·已取消] 内容 —— 了结原因 (立于 X · 目标 Y)。了结方式与原因是关键:告诉主模型
 * 「这事怎么下架的、为什么」,消除「已完成却还反复提」的困惑。空则「(无)」。
 */
export function fmtResolvedPlans(plans: MemPlan[]): string {
  if (!plans.length) return '  (无)';
  return plans
    .map(p => {
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`立于 ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`目标 ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      const tag = `${p.kind === 'suspense' ? '悬念' : '计划'}·${outcomeLabel(p.kind, p.outcome)}`;
      const reason = oneLine(p.resolvedReason) ? ` —— ${oneLine(p.resolvedReason)}` : '';
      return `  - [${tag}] ${oneLine(p.content)}${reason}${time}`;
    })
    .join('\n');
}

export function fmtPlans(plans: BuildArgs['openPlans']): string {
  if (!plans.length) return '  (无)';
  return plans
    .map((p, idx) => {
      // 时间括注:有创建/目标时间才带上,格式 A —— (立于 X · 目标 Y),任一缺失则只显示存在的那个
      const parts: string[] = [];
      if (p.createdTime?.trim()) parts.push(`立于 ${p.createdTime.trim()}`);
      if (p.targetTime?.trim()) parts.push(`目标 ${p.targetTime.trim()}`);
      const time = parts.length ? `(${parts.join(' · ')})` : '';
      return `  p${idx + 1}. [${p.kind === 'suspense' ? '悬念' : '计划'}] ${oneLine(p.content)}${time}`;
    })
    .join('\n');
}

/** 局势卡渲染给副 API(只读参考,单行内联)。null → (无)。 */
export function fmtSceneFocus(f: SceneFocus | null): string {
  if (!f) return '  (无)';
  const bits: string[] = [`局面:${oneLine(f.situation)}`];
  const who = f.participants.map(oneLine).filter(Boolean).join('、');
  if (who) bits.push(`在场:${who}`);
  if (f.currentFocus) bits.push(`焦点:${oneLine(f.currentFocus)}`);
  if (f.tension) bits.push(`张力:${oneLine(f.tension)}`);
  if (f.pendingBeat) bits.push(`将发生:${oneLine(f.pendingBeat)}`);
  return `  ${bits.join(' | ')}`;
}

/** 生活小档案渲染给副 API(编号 d1/d2… 供 update/archive/remove 指代)。 */
export function fmtLifeDetails(details: MemLifeDetail[], userName = '主角'): string {
  if (!details.length) return '  (无)';
  return details
    .map((d, idx) => {
      const tierLabel = d.tier === 'pinned' ? '置顶' : d.tier === 'archive' ? '沉降' : d.until ? `时效·至${oneLine(d.until)}` : '长期';
      const meta: string[] = [];
      if (d.topics.length) meta.push(`主题:${d.topics.map(oneLine).filter(Boolean).join('/')}`);
      if (d.anchors.length) meta.push(`词:${d.anchors.map(oneLine).filter(Boolean).join('/')}`);
      return `  d${idx + 1}. [${tierLabel}] ${oneLine(fmtLifeDetail(d, userName))}${meta.length ? ` (${meta.join(' | ')})` : ''}`;
    })
    .join('\n');
}

function fill(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? '');
}

/**
 * 字数档位配置:详细(默认)/ 精简。三处字数 + 二次总结的比例区间随档位一并切换。
 * 仅作用于内置模板的 {{summary_words}} / {{resummary_words}} / {{target_min}} / {{target_max}} 宏;
 * {{target}} 作为旧自定义模板的兼容宏,等同于 {{target_max}}。用户自填模板里若使用这些宏也会按档位填充。
 */
interface VerbosityProfile {
  summaryWords: string; // 摘要字数范围(填进 {{summary_words}})
  /** 摘要硬上限(字符,含标点),填进 {{summary_max_chars}};作为上限而非凑满目标 */
  summaryMaxChars: number;
  resummaryWords: string; // 普通总结字数范围(填进 {{resummary_words}})
  resummary2MinRatio: number; // 二次总结最低字数 = 输入总字数 × 最低比例
  resummary2MaxRatio: number; // 二次总结最高字数 = 输入总字数 × 最高比例
}
const VERBOSITY_PROFILES: Record<Verbosity, VerbosityProfile> = {
  detailed: {
    summaryWords: '150-300',
    summaryMaxChars: 360,
    resummaryWords: '300-500',
    resummary2MinRatio: 0.4,
    resummary2MaxRatio: 0.5,
  },
  concise: {
    summaryWords: '80-150',
    summaryMaxChars: 180,
    resummaryWords: '150-300',
    resummary2MinRatio: 0.3,
    resummary2MaxRatio: 0.4,
  },
};

/** 取当前生效的字数档位配置(读 apiSettings.verbosity,非法值兜底详细)。 */
function currentVerbosity(): VerbosityProfile {
  return VERBOSITY_PROFILES[apiSettings.verbosity] ?? VERBOSITY_PROFILES.detailed;
}

/**
 * 自定义摘要模板不会自动继承内置模板新增的字段,故单独发送最小兼容协议。
 * 这样老用户无需手动重置模板,也能开始产出 protagonist 增量。
 */
const PROTAGONIST_PROTOCOL_SUPPLEMENT = `【柏宝书主角档案兼容协议】
无论自定义模板是否提到本协议,最终 JSON 根对象都允许按需包含 protagonist:
{
  "protagonist": {
    "gender": "性别/性别表现",
    "age": "年龄(仅首次明确或明确变化才写,写原话值,勿自行按时间换算)",
    "identity": "当前身份/职业/种族/公开地位",
    "appearance": "当前稳定外貌/身体特征",
    "outfit": "当前完整着装",
    "condition": "身体状态/健康变化后的完整内容(未解除的旧伤照抄;空字符串=完全恢复)"
  }
}
字段省略表示保持旧值;空字符串表示明确清空旧值。

${RULE_PROTAGONIST}`;

/**
 * v0.17 默认模板教的是已停用的伤情片段补丁:照它写,补丁会被清洗丢掉,已有伤情的主角/NPC 就再也更新不了。
 * 它的主角规则除伤情写法外与现行一致,只纠正这一处即可,不必整段重发主角规则。
 */
const CONDITION_PATCH_RETIRED_SUPPLEMENT = `【柏宝书伤情写法更正】
自定义模板中的 conditionPatch(伤情片段补丁)与【伤情局部更新协议】已停用,系统不再读取,也不再提供伤情编号。主角与 NPC 的 condition 一律整段覆盖:有变化时写变化后的完整状态,尚未解除的旧伤照抄,确已完全恢复写空字符串;没有变化就省略。模板里“有旧伤情时改用 conditionPatch”“已有非空伤情则省略此字段”“不整段覆盖”之类的说法,以本更正为准。`;

/** 自定义摘要可能没用 {{time_field}}/{{time_rule}},无标签楼仍须强制产出锚点字段。 */
const TIME_ANCHOR_PROTOCOL_SUPPLEMENT = `【柏宝书时间锚点兼容协议】
本轮正文没有可读取的时间标签。无论自定义模板是否提到时间,最终 JSON 根对象都必须包含:
{
  "timeStart": "本段开始时的完整故事内时间",
  "timeEnd": "本段结束时的完整故事内时间"
}
两字段均不得省略,须写完整时间(不受摘要叙述“不补年份、分钟”的限制);若本段时间没有推进,写相同的完整时间。

${RULE_COMPLETE_TIME_ANCHOR}`;

/** 自定义摘要可能没提局势卡;补充 sceneFocus 字段协议(可选字段,不破坏旧模板)。 */
const SCENE_FOCUS_PROTOCOL_SUPPLEMENT = `【柏宝书互动局势卡兼容协议】
最终 JSON 根对象可增加一个可选字段(没有实质变化就不要输出它):
{
  "sceneFocus": { "situation": "当前局面一句话(日常写氛围,剧情写处境;口述带来源)", "participants": ["在场参与者名"], "tension": "互动张力(可选,高门槛)", "pendingBeat": "正文明确预告的即将发生之事(可选,禁预测,不重复 situation)" }
}
省略表示保持上一张;写 null 表示明确清空。

${RULE_SCENE_FOCUS}`;

/** 自定义摘要可能没提生活小档案;补充 lifeDetails 字段协议(可选字段,不破坏旧模板)。 */
const LIFE_DETAILS_PROTOCOL_SUPPLEMENT = `【柏宝书生活小档案兼容协议】
本协议更新旧模板的“仅主角”限制:现支持主角及主要角色,必须明确人物归属,其他事实准入门槛不变。
最终 JSON 根对象可增加一个可选字段(没有可记的就不要输出它):
{
  "lifeDetails": {
    "add": [{ "subject": "user或主要角色在NPC名册中的确切名字", "text": "该人物明说过/正文明确揭示的偏好、习惯或近期状态一句话", "topics": ["主题标签"], "anchors": ["原文关键词"], "until": "故事内到期时间(长期偏好留空,可选)" }],
    "update": [{ "id": "d1", "subject": "明确纠正归属时才填;省略保持", "text": "纠正后的新内容(可选)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }
}

${RULE_LIFE_DETAILS}`;

/** 当前是否在用内置摘要模板(空=内置;等于内置默认也算内置)。 */
export function isBuiltinSummaryPrompt(): boolean {
  const custom = apiSettings.prompts.summary.trim();
  return !custom || custom === SUMMARY_PROMPT.trim();
}

/** 内置规则与材料分别展开;自定义模板不猜测边界,只将兼容规范移到 system。 */
export function buildSummaryPrompt(a: BuildArgs): { system: string; user: string } {
  const custom = apiSettings.prompts.summary.trim();
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    history_block: a.history.trim() || '(无,这是开篇)',
    state_time: a.time || '(未知)',
    state_location: a.location || '(未知)',
    protagonist_block: fmtProtagonist(a.protagonist),
    items_block: fmtItems(a.items),
    itemlog_block: fmtItemLog(a.itemLog),
    scenes_block: fmtScenes(a.scenes),
    npcs_block: fmtNpcs(a.npcs),
    plans_block: fmtPlans(a.openPlans),
    resolved_plans_block: fmtResolvedPlans(a.resolvedPlans),
    scenefocus_block: fmtSceneFocus(a.sceneFocus),
    lifedetails_block: `- 生活小档案(已记录,用编号 d1/d2… 指代;只读参考,勿重复记录 —— 见【生活小档案规则】):\n${fmtLifeDetails(a.lifeDetails, a.user || '主角')}\n`,
    lifedetails_field: LIFE_DETAILS_FIELD_TMPL,
    lifedetails_rule: `\n${RULE_LIFE_DETAILS}\n`,
    // 了解清单三处:功能关闭(未传 knowledge)时全为空串,提示词与关闭前一字不差
    knowledge_block: a.knowledge
      ? `- 角色对主角的了解(相关角色已记下的认知,用编号 k1/k2… 指代;只读参考,勿重复记录 —— 见【了解清单规则】):\n${fmtKnowledgeForSummary(a.knowledge)}\n`
      : '',
    knowledge_field: a.knowledge ? KNOWLEDGE_FIELD_TMPL : '',
    knowledge_rule: a.knowledge ? `\n${RULE_KNOWLEDGE}\n` : '',
    content: a.content,
    time_field: a.hasTimeTags ? TIME_FIELD_WITH_TAGS : TIME_FIELD_NO_TAGS,
    time_rule: a.hasTimeTags ? TIME_RULE_WITH_TAGS : TIME_RULE_NO_TAGS,
    summary_words: currentVerbosity().summaryWords,
    summary_max_chars: String(currentVerbosity().summaryMaxChars),
    // 自定义变量三处:未配置变量(空状态 + 空说明)时全为空串(零 token 开销,老用户行为不变)
    vars_state_block: hasVars(a)
      ? `- 自定义变量·当前状态(结算到此刻的 JSON,只读参考,严禁重复结算):\n${renderVarsState(a.varsState)}`
        + (a.varsMeaning.trim() ? `\n- 变量含义(各字段是什么):\n${a.varsMeaning.trim()}` : '')
        + (a.varsRule.trim() ? `\n- 变量变化规则(何时怎么改/可否新建):\n${a.varsRule.trim()}` : '')
      : '',
    vars_field: hasVars(a) ? VARS_FIELD_TMPL : '',
    vars_rule: hasVars(a) ? `\n${RULE_VARS}\n` : '',
    // 供自定义模板单独取用的原始块
    vars_block: renderVarsState(a.varsState),
    varlog_block: [a.varsMeaning.trim(), a.varsRule.trim()].filter(Boolean).join('\n\n') || '(无)',
  };
  if (isBuiltinSummaryPrompt()) {
    return { system: fill(SUMMARY_RULES, macros), user: fill(SUMMARY_INPUT, macros) };
  }
  const prompt = fill(custom, macros);
  // 照内置模板改的自定义模板本身就带这些节,再补就是同一规则发两遍、新旧口径并存。
  // 主角/局势卡/好感是模板正文,认带 ═══ 的标题行(材料和核心原则里「见/按【…规则】」的引用不算);
  // 生活小档案/了解清单经宏展开,认宏——手抄进模板的旧版「仅主角」口径仍需兼容协议改写
  const supplements: string[] = [];
  if (!prompt.includes('═══ 【主角当前档案规则】')) supplements.push(PROTAGONIST_PROTOCOL_SUPPLEMENT);
  // v0.17 默认模板教的是已停用的伤情补丁(conditionPatch),只补一句更正,主角与 NPC 都管
  if (custom.includes('conditionPatch')) supplements.push(CONDITION_PATCH_RETIRED_SUPPLEMENT);
  // 时间铁律:模板自带的(多为旧版)就不再补,免得新旧两版同时出现、口径互斥。
  // 查原模板而非展开后的 prompt:无时间标签时 {{time_rule}} 的正文也提到铁律名,会被误判成自带而漏补
  if (!custom.includes('【摘要时间语言铁律】')) supplements.push(RULE_ABSOLUTE_TIME_LANGUAGE);
  if (!prompt.includes('═══ 【互动局势卡规则】')) supplements.push(SCENE_FOCUS_PROTOCOL_SUPPLEMENT);
  if (!custom.includes('{{lifedetails_rule}}')) supplements.push(LIFE_DETAILS_PROTOCOL_SUPPLEMENT);
  if (a.knowledge && !custom.includes('{{knowledge_rule}}')) supplements.push(KNOWLEDGE_PROTOCOL_SUPPLEMENT);
  if (!prompt.includes('═══ 【内心好感与外在态度规则】')) supplements.push(RULE_NPC_AFFINITY);
  // 关系线保留:自定义模板未带入时补上,保证慢热互动不在摘要/压缩里被删空(与内置模板同源)
  if (!prompt.includes('【关系线保留】')) supplements.push(RULE_RELATION_MOMENTUM);
  // {{time_rule}} 在无时间标签时本身已经带有完整时间协议;
  // 只有自定义模板没有带入它时,才追加兼容协议,避免完整时间要求重复注入。
  if (!a.hasTimeTags && !prompt.includes('【完整时间锚点格式(系统强制)】')) {
    supplements.push(TIME_ANCHOR_PROTOCOL_SUPPLEMENT);
  }
  return {
    system: fill(supplements.join('\n\n'), macros),
    user: `${prompt}\n\n【主角当前档案(本轮之前,只读参考)】\n${macros.protagonist_block}`
      + (prompt.includes(macros.npcs_block) ? '' : `\n\n【已登场NPC(本轮之前,好感估计只作基线,不重复结算)】\n${macros.npcs_block}`)
      + (prompt.includes(macros.lifedetails_block.trim()) ? '' : `\n\n${macros.lifedetails_block}`)
      + (!a.knowledge || prompt.includes(macros.knowledge_block.trim()) ? '' : `\n\n${macros.knowledge_block}`),
  };
}

/** 是否启用了自定义变量(有当前状态或说明)。 */
function hasVars(a: BuildArgs): boolean {
  return Object.keys(a.varsState).length > 0 || a.varsMeaning.trim().length > 0 || a.varsRule.trim().length > 0;
}

/** vars 字段的 JSON 模板片段(接在 plans 之后,故带前导逗号)。命令数组,见【自定义变量规则】。 */
const VARS_FIELD_TMPL = `,
  "vars": [ { "op": "set|add|assign|remove", "path": "点/括号路径", "key": "assign/remove 用(可选)", "value": "set/assign 用(可选)", "delta": "add 用的数字(可选)" } ]`;

/** 生活小档案字段的 JSON 模板片段(接在 plans 之后,故带前导逗号)。 */
const LIFE_DETAILS_FIELD_TMPL = `,
  "lifeDetails": {
    "add": [{ "subject": "user或主要角色在NPC名册中的确切名字", "text": "该人物明说过/正文明确揭示的偏好、习惯或近期状态一句话", "topics": ["主题标签,1-3个"], "anchors": ["原文关键词"], "until": "故事内到期时间(长期偏好留空,可选)" }],
    "update": [{ "id": "d1", "subject": "明确纠正归属时才填;省略保持", "text": "纠正后的新内容(可选)", "topics": ["新标签(可选,整体覆盖)"], "anchors": ["新关键词(可选,整体覆盖)"], "until": "新时效(可选;空字符串=清除)" }],
    "archive": ["d2"],
    "remove": ["d3"]
  }`;

/** 了解清单字段的 JSON 模板片段(带前导逗号,接在 lifeDetails 之后)。 */
const KNOWLEDGE_FIELD_TMPL = `,
  "knowledge": {
    "add": [{ "who": "NPC名册中的确切名字(不能是主角)", "text": "该角色本轮亲耳听到/亲眼看到/被告知的主角的一件事,一句话,开头写把握:认定/怀疑/听说/主角自称" }],
    "update": [{ "id": "k1", "text": "认知被纠正或加深后的新内容" }],
    "remove": ["k2"]
  }`;

/** 自定义摘要模板不认识了解清单;功能开启时补字段协议(可选字段,不破坏旧模板)。 */
const KNOWLEDGE_PROTOCOL_SUPPLEMENT = `【柏宝书了解清单兼容协议】
最终 JSON 根对象可增加一个可选字段(没有可记的就不要输出它):
{
${KNOWLEDGE_FIELD_TMPL.replace(/^,\n/, '')}
}

${RULE_KNOWLEDGE}`;

/**
 * 批量摘要的参数。批量只产 summary + 起止时间,故不传物品/计划(避免多楼顺序错乱)——
 * 只保留时间/地点/前情作只读背景,帮 AI 推算时间、理解场景。
 */
export interface BatchBuildArgs {
  user: string;
  char: string;
  /** 这批楼层开头之前的已知时间(只读背景,帮 AI 推算各楼时间) */
  time: string;
  /** 这批楼层开头之前的已知地点(只读背景) */
  location: string;
  history: string;
  /** 多楼拼接正文(每楼前带「━━ 第 n 楼 ━━」分隔) */
  content: string;
  /** 本批楼数(= floors 数组应有长度) */
  floorCount: number;
}

/** 构造批量摘要提示词。用户自定义模板(prompts.summary)不作用于批量——批量用内置 BATCH_SUMMARY_PROMPT。 */
export function buildBatchSummaryPrompt(a: BatchBuildArgs): { system: string; user: string } {
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    history_block: a.history.trim() || '(无,这是开篇)',
    state_time: a.time || '(未知)',
    state_location: a.location || '(未知)',
    content: a.content,
    floor_count: String(a.floorCount),
    summary_words: currentVerbosity().summaryWords,
    // 撰写段截自单楼模板,带着字符上限宏;漏填会被 fill 静默替换成空串
    summary_max_chars: String(currentVerbosity().summaryMaxChars),
  };
  return { system: fill(BATCH_SUMMARY_RULES, macros), user: fill(BATCH_SUMMARY_INPUT, macros) };
}

/** 填充批量思考清单里的 {{floor_count}} 宏。 */
export function buildBatchThinking(floorCount: number): string {
  return fill(BATCH_THINKING_CHECKLIST, { floor_count: String(floorCount) });
}

/**
 * 二次总结字数区间:详细为内容总字数的 40%–50%,精简为 30%–40%。
 */
export function resummary2Targets(contentLen: number): { min: number; max: number } {
  const v = currentVerbosity();
  return {
    min: Math.round(contentLen * v.resummary2MinRatio),
    max: Math.round(contentLen * v.resummary2MaxRatio),
  };
}

/**
 * 构造总结提示词。按层级分两套:
 *  - level<=1(L0 叶子 → L1):普通总结,固定字数 → RESUMMARY_PROMPT。
 *  - level>=2(L1+ → 更上层):二次总结,目标字数随输入规模动态给 → RESUMMARY2_PROMPT。
 * 各自优先用对应的自定义模板,空则回退内置。字数随档位(详细/精简)切换。
 */
export function buildResummaryPrompt(
  a: Pick<BuildArgs, 'user' | 'char' | 'content'> & { level: number },
): { system: string; user: string } {
  const isSecond = a.level >= 2;
  const custom = isSecond
    ? apiSettings.prompts.resummary2.trim()
    : apiSettings.prompts.resummary.trim();
  const builtin = isSecond ? RESUMMARY2_PROMPT : RESUMMARY_PROMPT;
  const targets = isSecond ? resummary2Targets(a.content.length) : { min: 0, max: 0 };
  const macros = {
    user: a.user || '主角',
    char: a.char || '角色',
    content: a.content,
    resummary_words: currentVerbosity().resummaryWords,
    target_min: isSecond ? String(targets.min) : '',
    target_max: isSecond ? String(targets.max) : '',
    // 兼容保存过旧版 {{target}} 的自定义模板;旧语义对应目标/最高字数。
    target: isSecond ? String(targets.max) : '',
  };
  if (custom && custom !== builtin.trim()) {
    // 与摘要同理,模板自带的段不重复补;两段都带时 system 为空,由调用方略过该消息
    const supplements: string[] = [];
    if (!custom.includes('【摘要时间语言铁律】')) supplements.push(RULE_ABSOLUTE_TIME_LANGUAGE);
    if (!custom.includes('【关系线保留】')) supplements.push(RULE_RELATION_MOMENTUM);
    return { system: supplements.join('\n\n'), user: fill(custom, macros) };
  }
  return {
    system: fill(isSecond ? RESUMMARY2_RULES : RESUMMARY_RULES, macros),
    user: fill(isSecond ? RESUMMARY2_INPUT : RESUMMARY_INPUT, macros),
  };
}

/**
 * 把用户人设(persona)包成独立 system 消息(摘要需据此理解「主角是谁」,
 * 正确写 summary、判断 NPC 与主角的互动)。空人设时调用方应跳过。
 * 字段已由调用方(fetchUserPersona)展开宏;这里只描述它是「主角本人设定」,与角色卡区分。
 */
/** 资料包装模板(09):固定措辞 + 动态资料占位,直接取自原文,避免手抄走样。 */
const DATA_WRAPPERS = (() => {
  const out: Record<string, string> = {};
  for (const block of dataWrappersRaw.split(/\n\s*\n(?=【)/)) {
    const name = block.match(/^【([^】]+)】/)?.[1];
    if (name) out[name] = block.replace(/〔[^〕]*〕[\s\S]*$/, '').replace(/\s+$/, '');
  }
  return out;
})();
function dataWrapper(prefix: string): string {
  const want = prefix.replace(/^【/, '');
  const key = Object.keys(DATA_WRAPPERS).find(k => k.startsWith(want));
  return key ? DATA_WRAPPERS[key] : '';
}

export function buildPersonaSystem(persona: string): string {
  return `${dataWrapper('【主角设定')}\n\n${persona.trim()}`;
}

/** 把世界书设定包成独立 system 消息的内容(空设定时调用方应跳过) */
export function buildWorldInfoSystem(worldInfo: string): string {
  return `${dataWrapper('【世界设定')}\n\n${worldInfo.trim()}`;
}

/**
 * 把角色卡描述包成独立 system 消息(有些卡人设写在角色描述而非世界书里,摘要也需据此理解角色)。
 * 字段已由调用方展开宏并按非空拼好;空则调用方应跳过本块。
 */
export function buildCharCardSystem(charCard: string): string {
  return `${dataWrapper('【角色设定')}\n\n${charCard.trim()}`;
}

/* ============ 思维链(机制照搬 Horae,字段适配 BaiBai 的 JSON) ============ */

/**
 * 「输出前思考」检查清单,作为 system 提示压在 user_input 之后。
 * 思考点对齐 Horae(本楼核心事件→物品清点→悬念清算→收笔位置→格式自检),
 * 但字段名/格式全部对齐 BaiBai 的 JSON(summary/time/location/items/plans),不提 <horae> 标签。
 */
export const THINKING_CHECKLIST = protocolSection('THINKING_CHECKLIST');

/** 了解清单盘点,挂在 NPC 盘点下;同规则一样只在功能开启时出现,关闭时清单与没有此功能时一字不差。 */
const KNOWLEDGE_CHECK = `
   - 了解清单:对照「角色对主角的了解」,本楼有谁亲耳听到、亲眼看到或听人转告了{{user}}的名字、身世、经历、秘密、私人喜好或自称的身份?未记过 → knowledge.add,照该角色以为的写;旧认知被揭穿或加深 → update 原条,不另加矛盾的一条。{{user}}的内心独白、该角色不在场时发生的事不算。`;

/** 与批量清单一样在发送前展开宏,不把占位符留给渠道处理。 */
export function buildSummaryThinking(user: string, knowledge = false): string {
  const name = user || '主角';
  // 宏值不会再展开一遍,盘点项里的 {{user}} 得先填
  return fill(THINKING_CHECKLIST, { user: name, knowledge_check: knowledge ? fill(KNOWLEDGE_CHECK, { user: name }) : '' });
}

/* ============ 向量召回:查询重写(Query Rewrite) ============ */

/** 查询重写可用的宏(供设置页展示) */
export const QUERY_REWRITE_MACROS: PromptMacro[] = [
  { token: '{{history_block}}', desc: '历史剧情摘要(已注入为前置上下文)' },
  { token: '{{state_snapshot}}', desc: '状态快照(滚出窗口的物品/计划)' },
];

/**
 * 查询重写系统提示词(复刻 Horae,用户已优化版)。
 * 让小模型把「最近剧情 + 状态」重写成 INTENT + 多条检索 Q,供向量召回多路检索 + RRF 融合。
 */
export const QUERY_REWRITE_SYSTEM = `你是角色扮演续写场景中的上下文规划器。

背景:
用户正在和AI进行角色扮演对话。对话历史中的assistant消息是AI扮演角色的回复。用户的消息是用户扮演角色的行为、台词或指令(如"继续""剧情推进")。
你的下游有一个向量数据库,存储着所有已经发生过的历史剧情片段。
你的任务是:判断AI续写下一段剧情时可能需要哪些历史信息,生成检索查询去召回这些信息。

核心原则:
你不是在分析"用户想查什么"。用户的消息是角色的台词或行为,不是搜索请求。
你要思考的是:AI接下来要续写这段剧情,它可能需要参考哪些已经发生过的事件、设定、关系、伏笔,才能写得连贯、准确、丰富?
然后为这些内容生成检索查询。
你无法知道数据库中实际存储了什么。因此你的策略是尽可能多角度覆盖,让召回成功的概率最大化。召回为空没有成本,漏掉关键信息会导致续写出错。

工作流程:

第一步:理解当前场景
从最近几轮对话中提取:
- 当前的时间、地点、在场人物
- 正在进行的事件或对话话题
- 人物当前的情绪状态和行为动向
- 如果用户发出的是推进指令(如"继续""剧情推进"),判断剧情即将进入什么阶段

第二步:识别续写可能涉及的历史依赖
思考AI续写时,哪些不在当前对话窗口中的历史信息可能被需要。从以下所有维度展开思考:
- 当前话题涉及的过去事件,对话中只提了一句但缺少细节的
- 即将进入的场景或地点,过去是否有过相关描写、事件、设定
- 在场人物之间的关系发展史、过去的关键互动
- 涉及人物的能力、习惯、性格特征的历史表现
- 已经埋下但尚未解决的伏笔、悬念、未完成的事件线
- 世界观设定中与当前情节相关的规则或背景
- 当前对话中出现的物品、地名、组织名等专有名词的历史出处
- 人物之间可能存在的、与当前情绪或话题相关的过往经历

第三步:生成检索查询
- 固定生成5条查询
- 用自然语言短句,接近小说叙事或剧情概述的风格
- 每条查询指向一个明确且不同的召回目标
- 5条查询必须覆盖尽可能多的不同维度:事件经过、人物关系、能力设定、环境描写、伏笔线索、情感历史、世界观背景等
- 包含具体的人名、地名、事件名,不要使用代词
- 不要复述当前对话窗口中已经完整呈现的内容(AI已经能看到这些),查询应指向窗口之外可能存在的信息
- 所有查询只能指向过去已经发生的事,不要推测尚未发生的事件

查询角度参考(每次从中选取最相关的5个方向):
- 当前话题背后的历史事件细节
- 相关人物过去在类似场景下的行为模式
- 即将进入的地点或场景的已有描写和事件
- 人物之间的关系史和关键转折点
- 能力系统、魔法规则、世界观设定中的相关约束
- 当前情绪状态的历史成因
- 对话中提及的物品或线索的来源和背景
- 已埋下的伏笔和悬而未决的事件线
- 与当前事件模式相似的过往事件

禁止事项:
- 不要回答用户的问题或续写剧情
- 不要解释你的推理过程
- 不要编造上下文中没有依据的人物、事件或设定
- 不要生成指向未来尚未发生事件的查询
- 不要重复召回相同或高度相似的内容

INTENT的写法要求:
- 用一段自然语言描述当前场景的核心信息,包含具体的人名、地名、事件、人物状态和关系
- 风格接近剧情摘要或小说叙事,不要使用元叙事用语(如"剧情即将进入""阶段""推进")
- 目的是在精排阶段作为全文匹配的上下文,因此要尽可能覆盖当前场景涉及的关键实体和事实
- 包含当前窗口中与检索相关的核心事实,让精排模型能判断候选片段与当前情境的关联程度
- 长度2到4句话

输出格式:
第一行以 INTENT: 开头,按上述要求写当前场景描述。
之后恰好5行,每行以 Q: 开头,写一条检索查询。
不要输出任何其他内容。

---

示例1:

对话背景:陆远舟在天渊城被暗杀昏迷,苏晚宁赶到后一直在照顾他。最近一轮assistant写到苏晚宁在客栈翻看陆远舟的随身物品,发现一封被撕碎的信。用户最新消息是苏晚宁把碎片拼起来试图辨认字迹。

输出:
INTENT: 苏晚宁在天渊城客栈中拼凑陆远舟随身携带的碎信,试图辨认字迹和寄信人。陆远舟此前在天渊城遭暗杀陷入昏迷,苏晚宁赶到后一直守在他身边照顾并开始调查暗杀真相。
Q: 陆远舟在天渊城被暗杀前与哪些人有过书信往来
Q: 陆远舟抵达天渊城的原因和他此行的目的
Q: 天渊城中与陆远舟有过接触或敌对关系的势力和人物
Q: 苏晚宁与陆远舟之间的关系发展和信任变化历程
Q: 陆远舟过去是否有过隐瞒身份或秘密行动的记录

示例2:

对话背景:两人在教室里,期末考试前一周,角色A对角色B说"这次应该能考好吧",语气有点心虚。

输出:
INTENT: 期末考试前一周,角色A在教室里对角色B说"这次应该能考好吧",语气心虚。角色A似乎对自己的考试表现缺乏信心。
Q: 角色A过去的考试成绩记录和学业表现
Q: 角色A和角色B在过去考试期间的互动和共同经历
Q: 角色A在学业上是否遭遇过挫折或受到过压力
Q: 角色B对角色A学习能力或态度的看法和过往评价
Q: 角色A最近的学习状态和备考行为的相关描写

示例3:

对话背景:木白白和user讨论了多个地点出现恶魔的帖子,确认的场公园比鸡山更早出现异常,木白白提到自己从未遇到过其他魔法少女。当前场景是两人在玄关准备出门前往的场公园踩点。用户最新消息是"剧情推进"。

输出:
INTENT: 木白白和user在玄关准备出门前往的场公园,调查近期多地出现的恶魔袭击事件。木白白昨晚在鸡山战斗后已补充魔力,但她从未遇到过其他魔法少女,只能独自应对。的场公园的异常记录早于鸡山,两处恶魔可能存在关联。
Q: 的场公园过去发生的异常事件和恶魔目击报告的具体描述
Q: 木白白在鸡山与恶魔战斗时恶魔的外形特征和攻击行为
Q: 木白白的变身形态、武器、魔力上限等战斗能力的已知设定
Q: 木白白的魔力补充方式和补充后恢复状态的具体描写
Q: 恶魔最近在不同地点扩散的时间规律和活动范围变化`;

/** 查询重写收尾提示词(放在对话末尾再强调一次任务与格式) */
export const QUERY_REWRITE_TAIL = `记住你的任务:
- 你是上下文规划器,不是角色扮演者,不要续写剧情
- 思考AI续写下一段需要参考哪些已发生的历史信息
- 所有查询只能指向过去已经发生的事
- 不要查询当前对话窗口中已经完整呈现的内容
- 严格按格式输出:一行INTENT加恰好5行Q,不要输出任何其他内容`;