import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiSettings } from '@/api/settings';
import {
  buildBatchSummaryPrompt,
  buildBatchThinking,
  buildCharCardSystem,
  buildPersonaSystem,
  buildResummaryPrompt,
  buildSummaryPrompt,
  buildSummaryThinking,
  buildWorldInfoSystem,
  JAILBREAK_PROMPT,
  isBuiltinSummaryPrompt,
  LEDGER_PROTOCOL,
  MEMORY_BRIEFING_END,
  MEMORY_BRIEFING_NOTE,
  QUERY_REWRITE_SYSTEM,
  QUERY_REWRITE_TAIL,
  RESUMMARY_PROMPT,
  RESUMMARY2_PROMPT,
  RESUMMARY_THINKING_CHECKLIST,
  RULE_ABSOLUTE_TIME_LANGUAGE,
  RULE_NPC_AFFINITY,
  RULE_PROTAGONIST,
  RULE_RELATION_MOMENTUM,
  RULE_SCENE_FOCUS,
  SUMMARY_MACROS,
  SUMMARY_OUTPUT_PROTOCOL,
  SUMMARY_PROMPT,
  THINKING_CHECKLIST,
} from './prompts';
import { START_TAG, TIME_TAG_PROMPT } from './timeTag';
import dataWrappersRaw from './prompts/data-wrappers.txt?raw';

const originalPrompts = { ...apiSettings.prompts };
const originalVerbosity = apiSettings.verbosity;

beforeEach(() => {
  Object.assign(apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
});

afterEach(() => {
  Object.assign(apiSettings.prompts, originalPrompts);
  apiSettings.verbosity = originalVerbosity;
});

const args: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User',
  char: 'Character',
  time: '2026/9/8 10:00',
  location: 'School',
  protagonist: {},
  sceneFocus: null,
  lifeDetails: [],
  items: [],
  itemLog: [],
  scenes: [],
  npcs: [],
  openPlans: [],
  resolvedPlans: [],
  history: 'Earlier events.',
  content: 'The current passage.',
  hasTimeTags: true,
  varsState: {},
  varsMeaning: '',
  varsRule: '',
};

function combined(parts: ReturnType<typeof buildSummaryPrompt>): string {
  return `${parts.system}\n\n${parts.user}`;
}

describe('new built-in prompts', () => {
  it('ships the fact-preservation rules (核心集中在破限,正文不再重复携带)', () => {
    const parts = buildSummaryPrompt(args);
    const system = parts.system;
    // NVWA 核心应集中在 JAILBREAK_PROMPT(占独立 system 位),不再出现在正文里
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(system).not.toContain('<nvwa_standalone_core>');
    expect(system).toContain('【物品规则】(items 字段,严格筛选)');
    expect(system).toContain('【NPC 规则】(npcs 字段,极严筛选)');
    expect(system).toContain('【计划/悬念规则】(plans 字段)');
    expect(system).toContain('【场景/地点规则】(scenes 字段,只记到过的有名地点)');
    expect(system).toContain('【摘要成文顺序】');
    expect(system).toContain('【空间事实边界】');
    expect(system).toContain('【摘要时间语言铁律】');
    expect(system).toContain('【摘要撰写规则】(summary 字段,必填)');
    // 伤情编号协议已停用:状态改回与着装相同的全文覆盖
    expect(system).not.toContain('【伤情局部更新协议】');
    expect(system).not.toContain('conditionPatch');
    // NPC 定位证据硬关卡已撤:引文对不上原文时会静默丢掉合法定位
    expect(system).not.toContain('locationEvidence');
    // 拆伤情补丁时漏删的残留:模型会去找已不存在的「局部协议」
    expect(system).not.toContain('局部协议');
    // qty 必填 + 数量不明不猜曾成死结,数不清的东西只能不记
    expect(system).toContain('按包装记一份');
    // 局势卡的氛围示范被删过,卡片退化成干巴巴的动作记录
    expect(system).toContain('陪伴/日常剧情写互动氛围');
    // 文风只有禁令、示范全是公文腔时,日常戏容易写成笔录或把互动删光
    expect(system).toContain('(互动删光)');
    // 氛围禁令写死过,原文明写的气氛也会被一并删掉
    expect(system).toContain('原文明写的气氛可照原意保留');
    // 填表样例曾要求「称谓+一句态度」,与规则打架,第一印象的态度会冻进只在质变时才改的 relation
    expect(system).not.toContain('称谓在前+一句态度');
    expect(system).toContain('不为凑格式补态度');
    expect(LEDGER_PROTOCOL).toContain('bbs_items');
  });

  it('keeps the material in user and the rules in system, with all macros expanded', () => {
    const parts = buildSummaryPrompt({
      ...args,
      protagonist: { identity: 'PROFILE_SENTINEL' },
      history: 'HISTORY_SENTINEL',
      varsState: { value: 'VARIABLE_SENTINEL' },
      varsMeaning: 'MEANING_SENTINEL',
      varsRule: 'VARIABLE_RULE_SENTINEL',
      content: 'BODY_SENTINEL',
    });
    const thinking = buildSummaryThinking(args.user);
    for (const sentinel of ['PROFILE_SENTINEL', 'HISTORY_SENTINEL', 'VARIABLE_SENTINEL', 'MEANING_SENTINEL', 'VARIABLE_RULE_SENTINEL', 'BODY_SENTINEL']) {
      expect(parts.user).toContain(sentinel);
      expect(parts.system + thinking).not.toContain(sentinel);
    }
    expect(parts.user).toContain('【本轮对话】');
    for (const text of [parts.system, parts.user, thinking]) {
      expect(text).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('fills the summary word range and the character cap per verbosity', () => {
    for (const verbosity of ['detailed', 'concise'] as const) {
      apiSettings.verbosity = verbosity;
      const prompt = combined(buildSummaryPrompt(args));
      expect(prompt).toContain(verbosity === 'detailed' ? '150-300' : '80-150');
      expect(prompt).toContain(verbosity === 'detailed' ? '360' : '180');
    }
    expect(SUMMARY_MACROS.map(m => m.token)).toContain('{{summary_max_chars}}');
    // 字数区间容易被当成任务去凑;「宁可明显短于上限」故意不恢复,免得底层摘要越写越薄
    expect(buildSummaryPrompt(args).system).toContain('没有最低篇幅任务');
  });

  it('keeps custom templates in user with the compatibility supplements in system', () => {
    apiSettings.prompts.summary = 'CUSTOM {{content}} {{protagonist_block}}';
    const parts = buildSummaryPrompt({ ...args, protagonist: { identity: 'CUSTOM_PROFILE' } });
    expect(parts.user).toContain(`CUSTOM ${args.content}`);
    expect(parts.user).toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain('CUSTOM_PROFILE');
    expect(parts.system).not.toContain(args.content);
    expect(parts.system).toContain('【柏宝书主角档案兼容协议】');
    // 补充段截自 summary.txt,标题一改就会静默截成空串
    expect(parts.system).toContain('【摘要时间语言铁律】');
    // 主角/局势卡补充原是手抄,落后内置缺了伤势证据与局势卡口径;截取后与内置同一份
    expect(parts.system).toContain('【临时伤势与恢复证据】');
    expect(parts.system).toContain('本楼结束时的局面');
    // 伤情更正只给教 conditionPatch 的 v0.17 模板,别的模板不必多这一段
    expect(parts.system).not.toContain('【柏宝书伤情写法更正】');
    expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
  });

  it('does not re-append the time rule a custom template already carries', () => {
    // 旧模板多自带旧版铁律,再补新版会两版口径并存
    apiSettings.prompts.summary = 'CUSTOM 【摘要时间语言铁律】 {{content}}';
    expect(buildSummaryPrompt(args).system).not.toContain('【摘要时间语言铁律】');
  });

  it('still appends the time rule when only the expanded {{time_rule}} mentions it', () => {
    // 无时间标签时 {{time_rule}} 展开的时间规则里提到了铁律名,不能当成模板自带而漏补
    apiSettings.prompts.summary = 'CUSTOM {{time_rule}} {{content}}';
    const parts = buildSummaryPrompt({ ...args, hasTimeTags: false });
    expect(parts.user).toContain('不受【摘要时间语言铁律】');
    expect(parts.system).toContain('═══ 【摘要时间语言铁律】');
  });

  it('does not repeat sections a template copied from the default already carries', () => {
    // 照内置改的模板自带全部规则节,再补就是同一规则发两遍;system 为空时 engine 会略过
    apiSettings.prompts.summary = `${SUMMARY_PROMPT}\n(自定义)`;
    const parts = buildSummaryPrompt({ ...args, knowledge: [{ id: 'know:t#0', subject: 'Character', text: '认定主角是行商', createdAt: 1 }] });
    expect(parts.system).toBe('');
    for (const title of ['主角当前档案规则', '互动局势卡规则', '生活小档案规则', '了解清单规则', '内心好感与外在态度规则', '关系线保留', '摘要时间语言铁律']) {
      expect(combined(parts).split(`═══ 【${title}】`)).toHaveLength(2);
    }
  });

  it('corrects the retired conditionPatch for templates copied from v0.17', () => {
    // v0.17 默认模板教的是已停用的伤情补丁:照写会被清洗丢掉,主角和 NPC 的伤情都更新不了。
    // 它自带主角节且只差伤情写法,补一句更正即可;再整段重发主角规则就是新旧两种写法并存
    apiSettings.prompts.summary = 'CUSTOM ═══ 【主角当前档案规则】 conditionPatch {{content}}';
    const system = buildSummaryPrompt(args).system;
    expect(system).toContain('【柏宝书伤情写法更正】');
    expect(system).toContain('主角与 NPC 的 condition 一律整段覆盖');
    expect(system).not.toContain('【柏宝书主角档案兼容协议】');
  });

  it('slices exactly one section for each shared rule', () => {
    // 按标题截取:标题改名会截成空串,两标题之间插进新节会被静默一起带走
    for (const [rule, title] of [
      [RULE_PROTAGONIST, '【主角当前档案规则】'],
      [RULE_SCENE_FOCUS, '【互动局势卡规则】'],
      [RULE_RELATION_MOMENTUM, '【关系线保留】'],
      [RULE_ABSOLUTE_TIME_LANGUAGE, '【摘要时间语言铁律】'],
      [RULE_NPC_AFFINITY, '【内心好感与外在态度规则】'],
    ]) {
      expect(rule.startsWith(`═══ ${title}`)).toBe(true);
      expect(rule.match(/═══/g)).toHaveLength(2);
      expect(rule).not.toMatch(/\{\{\w+_rule\}\}/);
    }
  });

  it('isBuiltinSummaryPrompt 区分内置/自定义', () => {
    expect(isBuiltinSummaryPrompt()).toBe(true);
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT });
    expect(isBuiltinSummaryPrompt()).toBe(true);
    apiSettings.prompts.summary = '自定义 {{content}}';
    expect(isBuiltinSummaryPrompt()).toBe(false);
  });

  it('sends the current output protocol in the checklist, not the schema system block', () => {
    const parts = buildSummaryPrompt(args);
    expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(THINKING_CHECKLIST).toContain('【输出前核查】');
    expect(THINKING_CHECKLIST).not.toContain('conditionPatch');
    // v0.17 清单漏了地点项,模型常整楼不记位置
    expect(THINKING_CHECKLIST).toContain('本楼定位');
    // 各字段盘点同样被砍过,NPC/物品常漏建漏更新、局势卡一直挂着旧场面
    for (const item of ['主角盘点', 'NPC 盘点', '局势盘点', '物品盘点', '生活小档案盘点', '计划/悬念盘点']) expect(THINKING_CHECKLIST).toContain(item);
    // 只剩「核对旧计划」时,悬念揭晓了也没人结案
    expect(THINKING_CHECKLIST).toContain('旧悬念逐条过');
    // 了解清单比清单晚加,一直没有盘点项,角色得知主角私事时容易漏记;功能关闭时整项不出现
    expect(buildSummaryThinking(args.user, true)).toContain(`本楼有谁亲耳听到、亲眼看到或听人转告了${args.user}的名字`);
    expect(buildSummaryThinking(args.user)).not.toContain('了解清单');
    // 曾要求新角色一律带 location 或 follow,远程联络、尚未现身的角色被逼着编位置
    expect(THINKING_CHECKLIST).not.toContain('location 或 follow');
    expect(THINKING_CHECKLIST).toContain('只被提起或远程联络的没交代所在就省略 location');
    expect(buildSummaryThinking(args.user)).toContain(args.user);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(RESUMMARY_THINKING_CHECKLIST).toContain('根键只有 summary');
  });

  it('treats a saved exact default as built-in while keeping the editor copy complete', () => {
    const before = [
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ];
    Object.assign(apiSettings.prompts, { summary: SUMMARY_PROMPT, resummary: RESUMMARY_PROMPT, resummary2: RESUMMARY2_PROMPT });
    expect([
      buildSummaryPrompt(args),
      buildResummaryPrompt({ ...args, level: 1 }),
      buildResummaryPrompt({ ...args, level: 2 }),
    ]).toEqual(before);
    for (const template of [SUMMARY_PROMPT, RESUMMARY_PROMPT, RESUMMARY2_PROMPT]) {
      expect(template).toContain('{{content}}');
      expect(template).toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
  });
});

describe('batch and compression prompts', () => {
  it('keeps batch floor boundaries, count macros and the summary-only protocol', () => {
    const parts = buildBatchSummaryPrompt({ ...args, floorCount: 3 });
    const prompt = combined(parts);
    const thinking = buildBatchThinking(3);
    expect(thinking).toContain(SUMMARY_OUTPUT_PROTOCOL);
    expect(thinking).toContain('这批共 3 楼');
    expect(thinking).toContain('每个元素只含 n / summary / timeStart / timeEnd');
    expect(thinking).toContain('现代/数字日期的两端都必须包含完整年份');
    expect(parts.system).toContain('长度必须等于 3');
    // 撰写规则截自单楼模板,两边不再各写一套;截取段不得带进单楼专属字段
    expect(parts.system).toContain('【摘要撰写规则】(summary 字段,必填)');
    expect(parts.system).toContain('【摘要时间语言铁律】');
    // 日常戏示范写在撰写规则里,批量随截取同步,不另抄一份
    expect(parts.system).toContain('(互动删光)');
    expect(parts.system).not.toContain('sceneFocus');
    expect(parts.user).toContain(args.content);
    expect(parts.system).not.toContain(args.content);
    expect(prompt + thinking).not.toMatch(/\{\{\w+\}\}/);
  });

  it('emits the compression schema with budgets and keeps sources in user', () => {
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.system).toContain('{ "summary":');
      expect(parts.user).toContain('x'.repeat(1000));
      expect(parts.system).not.toContain('x'.repeat(1000));
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
      expect(combined(parts)).not.toContain(SUMMARY_OUTPUT_PROTOCOL);
    }
    expect(combined(buildResummaryPrompt({ ...args, level: 1 }))).toContain('【关系线保留】');
    expect(combined(buildResummaryPrompt({ ...args, level: 2 }))).toContain('【事实证据边界(最高优先级)】');
  });

  it('keeps custom compression text in user and supplements in system', () => {
    apiSettings.prompts.resummary = 'CUSTOM L1 {{content}} {{resummary_words}}';
    apiSettings.prompts.resummary2 = 'CUSTOM L2 {{content}} {{target_min}} {{target_max}} {{target}}';
    for (const level of [1, 2] as const) {
      const parts = buildResummaryPrompt({ ...args, content: 'x'.repeat(1000), level });
      expect(parts.user).toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).not.toContain(level === 1 ? 'CUSTOM L1' : 'CUSTOM L2');
      expect(parts.system).toContain('【关系线保留】');
      expect(parts.system).toContain('【摘要时间语言铁律】');
      expect(parts.system).not.toMatch(/\{\{\w+\}\}/);
    }
  });

  it('leaves system empty when a custom compression template carries both supplements', () => {
    // 照内置模板改的自定义模板两段都自带;engine 会略过空 system
    apiSettings.prompts.resummary = '【摘要时间语言铁律】【关系线保留】 {{content}}';
    expect(buildResummaryPrompt({ ...args, level: 1 }).system).toBe('');
  });
});

describe('jailbreak, briefing and query rewrite', () => {
  it('replaces the old override with the bare NVWA core (no task note)', () => {
    expect(JAILBREAK_PROMPT).toContain('<nvwa_standalone_core>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_adult_content>');
    expect(JAILBREAK_PROMPT).toContain('<nvwa_safety_guardrails>');
    expect(JAILBREAK_PROMPT).not.toContain('【记忆整理任务说明】');
    expect(JAILBREAK_PROMPT).not.toContain('sanctuary_override_directive');
  });

  it('frames the briefing as past-only context that does not cap relationships or set prose style', () => {
    expect(MEMORY_BRIEFING_NOTE).toContain('不要输出简报的标签');
    expect(MEMORY_BRIEFING_END).toContain('不是上限');
    expect(MEMORY_BRIEFING_END).toContain('最后确认的位置与着装不保证仍然有效');
    expect(MEMORY_BRIEFING_END).toContain('不要模仿压缩记录的句式');
  });

  it('资料包装与 09 原文逐字一致(仅把占位换成实际资料)', () => {
    const section = (placeholder: string, sentinel: string) =>
      dataWrappersRaw
        .replace(placeholder, sentinel)
        .split(/\n\s*\n(?=【)/)
        .find(b => b.includes(sentinel))!
        .trim();
    expect(buildPersonaSystem('SENT')).toBe(section('〔主角设定占位〕', 'SENT'));
    expect(buildWorldInfoSystem('SENT')).toBe(section('〔世界书内容占位〕', 'SENT'));
    expect(buildCharCardSystem('SENT')).toBe(section('〔角色卡内容占位〕', 'SENT'));
  });

  it('keeps the original 5-query rewrite prompt (复刻 Horae 的用户优化版)', () => {
    expect(QUERY_REWRITE_SYSTEM).toContain('你是角色扮演续写场景中的上下文规划器');
    // 原版要求“固定生成5条查询”——多路召回 + RRF 融合靠的就是这 5 条覆盖面
    expect(QUERY_REWRITE_SYSTEM).toContain('固定生成5条查询');
    expect(QUERY_REWRITE_SYSTEM).toContain('INTENT');
    expect(QUERY_REWRITE_SYSTEM).toContain('示例1:');
    expect(QUERY_REWRITE_TAIL).toContain('恰好5行Q');
    expect(QUERY_REWRITE_TAIL).toContain('INTENT');
  });

  it('keeps the time-tag prompt on the anchor-initialising behaviour without the NVWA core', () => {
    expect(TIME_TAG_PROMPT).not.toContain('<nvwa_standalone_core>');
    expect(TIME_TAG_PROMPT).toContain('【时间锚点要求(系统强制)】');
    expect(TIME_TAG_PROMPT).toContain(`<${START_TAG}>`);
    expect(TIME_TAG_PROMPT).toContain('请你自行设定一个符合本世界观的具体起始时刻');
    expect(TIME_TAG_PROMPT).toContain('这是为记忆系统建立时间锚点所必需的合理设定,不算编造');
    expect(TIME_TAG_PROMPT).toContain('bbs_items');
  });
});
