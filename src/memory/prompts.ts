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
 *         {{items_block}} {{plans_block}} {{content}}
 */

export const SUMMARY_PROMPT = `你是严谨的剧情记忆整理员。请阅读下面的【本轮对话】,产出一份结构化记忆更新,并**只输出一个 JSON 对象**。

【主角】{{user}}  【角色】{{char}}

【当前已知状态】
- 当前时间:{{state_time}}
- 当前地点:{{state_location}}
- 现有物品:
{{items_block}}
- 未了结的计划/悬念(用编号 p1、p2… 指代):
{{plans_block}}

【本轮对话】
{{content}}

【你的任务】输出一个 JSON 对象,字段如下(无变化的字段可省略):

{
  "summary": "本轮剧情的高信息密度摘要(150-300字)。按时间先后叙述,保留具体的日期/时间、人名、地名、物品名、关键数值与重要台词大意;禁止用『不久后/后来』等模糊词抹除真实时间;用平实的叙述句,不要标题、列表、加粗等任何 markdown 标记。",
  "time": "本轮结束时故事内的当前时间(若本轮有推进则写新值,否则省略)",
  "location": "本轮结束时主角所在地点(有变化才写)",
  "items": {
    "add": [{ "name": "物品名", "desc": "简述(可选)", "qty": 数量(可选) }],
    "update": [{ "name": "已有物品名", "qty": 新数量(可选), "desc": "新描述(可选)" }],
    "remove": ["要移除的已有物品名"]
  },
  "plans": {
    "add": [{ "kind": "plan", "content": "新出现的计划/目标" }, { "kind": "suspense", "content": "新出现的悬念/未解之谜" }],
    "resolve": ["p1", "p3"]
  }
}

【规则】
- items 用「物品名」匹配现有物品:移除/更新时必须用上面【现有物品】里的原名。
- plans.resolve 用上面【未了结的计划/悬念】里的编号(如 "p2")指代已经达成或揭晓的项。
- plans.add 区分 kind:"plan"=主角的计划/目标/待办,"suspense"=悬念/伏笔/未解之谜。
- 仅在确有变化时输出对应指令;没有变化就不要包含该数组或字段。
- summary 是必填,其余按需。
- 严禁输出 JSON 以外的任何内容(不要解释、不要思维链、不要代码块围栏)。`;

export const RESUMMARY_PROMPT = `你是剧情记忆整理员。下面是若干段按时间先后排列的剧情摘要,请把它们融合成一段更凝练、连贯的上层摘要,**只输出一个 JSON 对象**。

【主角】{{user}}  【角色】{{char}}

【待融合的摘要(按时间先后)】
{{content}}

【要求】
- 保留关键的日期/时间、人名、地名、物品名、重大转折与因果链,去除重复与冗余。
- 按时间流叙述,语言冷峻客观、信息浓缩。
- 纯文本正文,不要 markdown。
- 只输出如下 JSON,不要任何其他内容:

{ "summary": "融合后的上层摘要正文" }`;

interface BuildArgs {
  user: string;
  char: string;
  time: string;
  location: string;
  /** 现有物品名列表 */
  items: { name: string; qty?: number; desc?: string }[];
  /** 未了结计划(顺序即编号 p1..pn) */
  openPlans: { kind: 'plan' | 'suspense'; content: string }[];
  /** 待摘要的正文 */
  content: string;
}

export function fmtItems(items: BuildArgs['items']): string {
  if (!items.length) return '  (无)';
  return items
    .map(i => {
      const qty = typeof i.qty === 'number' ? ` ×${i.qty}` : '';
      const desc = i.desc ? ` —— ${i.desc}` : '';
      return `  - ${i.name}${qty}${desc}`;
    })
    .join('\n');
}

export function fmtPlans(plans: BuildArgs['openPlans']): string {
  if (!plans.length) return '  (无)';
  return plans
    .map((p, idx) => `  p${idx + 1}. [${p.kind === 'suspense' ? '悬念' : '计划'}] ${p.content}`)
    .join('\n');
}

function fill(tpl: string, map: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => map[k] ?? '');
}

/** 构造楼层摘要提示词 */
export function buildSummaryPrompt(a: BuildArgs): string {
  return fill(SUMMARY_PROMPT, {
    user: a.user || '主角',
    char: a.char || '角色',
    state_time: a.time || '(未知)',
    state_location: a.location || '(未知)',
    items_block: fmtItems(a.items),
    plans_block: fmtPlans(a.openPlans),
    content: a.content,
  });
}

/** 构造二次总结提示词 */
export function buildResummaryPrompt(a: Pick<BuildArgs, 'user' | 'char' | 'content'>): string {
  return fill(RESUMMARY_PROMPT, {
    user: a.user || '主角',
    char: a.char || '角色',
    content: a.content,
  });
}
