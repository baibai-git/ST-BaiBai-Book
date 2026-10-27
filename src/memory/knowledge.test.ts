import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { addKnowledge, deriveMemory, editNpc, finalizeDelta, removeKnowledge, updateKnowledge } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { applyKnowledgeOps, cleanKnowledgeOps, finalizeKnowledge, fmtKnowledgeForSummary, fmtKnowledgeInjection, knowledgeId, selectKnowledgeForSummary } from './knowledge';
import { buildSummaryPrompt } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type MemKnowledge, type StoredDelta } from './types';

const original = {
  injection: { ...settings.apiSettings.injection },
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '林舟和艾琳在客栈里说话。',
  extra: { bbs_leaf: { id: `know-${++seq}`, text: '客栈对话', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const entry = (subject: string, text: string, i = 0): MemKnowledge => ({ id: `know:t#${i}`, subject, text, createdAt: 1 });
const leafId = (m: STMessage) => m.extra!.bbs_leaf!.id;
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'know-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.knowledge = true;
  settings.apiSettings.prompts.summary = '';
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('了解清单:AI 输出翻译', () => {
  it('k 序号翻成稳定 id,know: 原样保留,查无的丢弃;先改删后新增', () => {
    const shown = [{ id: 'know:a#0' }, { id: 'know:a#1' }];
    const ops = finalizeKnowledge({
      add: [{ who: ' 艾琳 ', text: '认定主角是行商' }, { who: 'alice', text: '听说主角会医术' }],
      update: [{ id: 'k2', text: '得知主角其实是王子' }, { id: 'k9', text: '查无此条' }, { id: 'know:b#3', text: '原样引用' }],
      remove: ['k1', 'kx'],
    }, shown, ['艾琳', 'Alice']);
    expect(ops).toEqual([
      { op: 'update', id: 'know:a#1', text: '得知主角其实是王子' },
      { op: 'update', id: 'know:b#3', text: '原样引用' },
      { op: 'remove', id: 'know:a#0' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'add', subject: 'Alice', text: '听说主角会医术' },
    ]);
  });
  it('who 只认名册:主角、查无此人、空文本整条丢弃', () => {
    const ops = finalizeKnowledge({ add: [{ who: '林舟', text: '自己' }, { who: '路人', text: '名册外' }, { who: '艾琳', text: ' ' }] }, [], ['艾琳']);
    expect(ops).toEqual([]);
    expect(finalizeKnowledge('乱写', [], ['艾琳'])).toEqual([]);
  });
  it('未传上下文=功能关闭整段丢弃;传了则本楼新登场的角色也算名册', () => {
    const raw = { npcs: { add: [{ name: '小夏' }] }, knowledge: { add: [{ who: '小夏', text: '听说主角会医术' }] } };
    expect(finalizeDelta(raw, [], []).knowledge).toBeUndefined();
    expect(finalizeDelta(raw, [], [], { shown: [], npcNames: ['艾琳'] }).knowledge)
      .toEqual([{ op: 'add', subject: '小夏', text: '听说主角会医术' }]);
  });
});

describe('了解清单:存储与重放', () => {
  it('同角色同义去重,不同角色各记各的;id = 叶子#操作序号', () => {
    const list: MemKnowledge[] = [];
    applyKnowledgeOps(list, [
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商。' },
      { op: 'add', subject: '小夏', text: '认定主角是行商' },
    ], { id: 'L1', createdAt: 1, time: '第一天' });
    expect(list.map(k => [k.id, k.subject, k.createdTime])).toEqual([['know:L1#0', '艾琳', '第一天'], ['know:L1#2', '小夏', '第一天']]);
    // 删了再记、改到和别条撞句:都按日志顺序施加
    applyKnowledgeOps(list, [
      { op: 'remove', id: 'know:L1#0' },
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'update', id: 'know:L1#2', subject: '艾琳' },
    ], { id: 'L2', createdAt: 2, time: '' });
    expect(list.map(k => [k.id, k.subject])).toEqual([['know:L2#1', '艾琳']]);
  });
  it('清洗丢弃坏操作,保持原顺序', () => {
    expect(cleanKnowledgeOps([
      { op: 'add', subject: ' 艾琳 ', text: ' 认定主角是行商 ' }, { op: 'add', subject: '', text: 'x' },
      { op: 'update', id: 'know:a#0' }, { op: 'update', id: 'know:a#0', text: '改' }, { op: 'remove' }, 'junk', { op: 'remove', id: 'know:a#1' },
    ])).toEqual([
      { op: 'add', subject: '艾琳', text: '认定主角是行商' },
      { op: 'update', id: 'know:a#0', text: '改' },
      { op: 'remove', id: 'know:a#1' },
    ]);
  });
  it('deriveMemory 重放幂等,截止点不泄漏未来', () => {
    const first = message({ knowledge: [{ op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const second = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }] });
    const chat = [first, second];
    expect(deriveMemory(chat).knowledge.map(k => [k.id, k.text])).toEqual([[a, 'A2']]);
    expect(deriveMemory(JSON.parse(JSON.stringify(chat))).knowledge).toEqual(deriveMemory(chat).knowledge);
    expect(deriveMemory(chat, 1).knowledge.map(k => k.text)).toEqual(['A', 'B']);
  });
  it('改过的条目挪到末尾:注入只发最近几条时,被纠正的认知不会当成旧条截掉', () => {
    const first = message({ knowledge: [
      { op: 'add', subject: '艾琳', text: '认定主角是行商' }, { op: 'add', subject: '艾琳', text: 'B' }, { op: 'add', subject: '艾琳', text: 'C' },
    ] });
    const second = message({ knowledge: [{ op: 'update', id: knowledgeId(leafId(first), 0), text: '得知主角其实是王子' }] });
    const list = deriveMemory([first, second]).knowledge;
    expect(list.map(k => k.text)).toEqual(['B', 'C', '得知主角其实是王子']);
    expect(fmtKnowledgeInjection(list, ['艾琳'], '林舟', 2)).toContain('艾琳:(另有 1 条较早的从略)\n  - C\n  - 得知主角其实是王子');
  });
  it('手动增改删写进最新叶子;角色改名清单跟着走', () => {
    const chat = [message({ npcs: { add: [{ name: '艾琳', important: true }] } }), message()];
    useChat(chat);
    expect(addKnowledge('艾琳', ' 认定林舟是行商 ')).toBe(true);
    const id = memory.knowledge[0].id;
    expect(id).toBe(knowledgeId(leafId(chat[1]), 0));
    expect(memory.knowledge[0]).toMatchObject({ subject: '艾琳', text: '认定林舟是行商' });
    expect(updateKnowledge(id, '得知林舟其实是王子')).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, text: '得知林舟其实是王子' });
    expect(editNpc('艾琳', { name: '艾莉' })).toBe(true);
    expect(memory.knowledge[0]).toMatchObject({ id, subject: '艾莉' });
    expect(removeKnowledge(id)).toBe(true);
    expect(memory.knowledge).toHaveLength(0);
    expect(addKnowledge('艾莉', '  ')).toBe(false);
  });
  it('继承:清单全量带进种子叶,窗口内的改写/删除跟着换 id', async () => {
    settings.apiSettings.keepRecent = 1;
    const first = message({ npcs: { add: [{ name: '艾琳', important: true }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' }] });
    const [a, b] = [0, 1].map(i => knowledgeId(leafId(first), i));
    const last = message({ knowledge: [{ op: 'update', id: a, text: 'A2' }, { op: 'remove', id: b }, { op: 'add', subject: '艾琳', text: 'C' }] });
    const chat = [first, message(), last];
    const source = useChat(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'know-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => { vi.mocked(context.getContext).mockReturnValue(target); });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(target.chat[0].extra!.bbs_leaf!.delta.knowledge).toEqual([
      { op: 'add', subject: '艾琳', text: 'A' }, { op: 'add', subject: '艾琳', text: 'B' },
    ]);
    expect(deriveMemory(target.chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['A2', 'C']);
  });
});

describe('了解清单:提示词与注入', () => {
  const args: Parameters<typeof buildSummaryPrompt>[0] = {
    user: '林舟', char: '艾琳', time: '', location: '', protagonist: {}, sceneFocus: null,
    lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [{ name: '艾琳', important: true }],
    openPlans: [], resolvedPlans: [], history: '', content: '说话', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
  };
  const shown = [entry('艾琳', '认定主角是行商'), entry('小夏', '听说主角会医术', 1)];
  it('副 API 按角色分组、编号全局连续', () => {
    const list = [entry('小夏', 'X'), entry('艾琳', 'Y', 1), entry('路人', 'Z', 2)];
    expect(selectKnowledgeForSummary(list, ['艾琳', '小夏', '艾琳']).map(k => k.text)).toEqual(['Y', 'X']);
    expect(fmtKnowledgeForSummary(shown)).toBe('  艾琳:\n    k1. 认定主角是行商\n  小夏:\n    k2. 听说主角会医术');
    expect(fmtKnowledgeForSummary([])).toBe('  (无)');
  });
  it('内置模板:开才带规则/字段/清单,关时一字不发;宏都展开', () => {
    const off = buildSummaryPrompt(args);
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    for (const p of [off, on]) expect(`${p.system}${p.user}`).not.toMatch(/\{\{\w+\}\}/);
    expect(`${off.system}${off.user}`).not.toContain('了解清单');
    expect(`${off.system}${off.user}`).not.toContain('"knowledge"');
    expect(on.system).toContain('【了解清单规则】');
    expect(on.system).toContain('"knowledge"');
    expect(on.user).toContain('k1. 认定主角是行商');
    expect(on.user).toContain('k2. 听说主角会医术');
  });
  it('自定义模板:开时补兼容协议与清单材料,关时不补', () => {
    settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const on = buildSummaryPrompt({ ...args, knowledge: shown });
    expect(on.system).toContain('【柏宝书了解清单兼容协议】');
    expect(on.system).toContain('【了解清单规则】');
    expect(on.user).toContain('k1. 认定主角是行商');
    const off = buildSummaryPrompt(args);
    expect(`${off.system}${off.user}`).not.toContain('了解清单');
  });
  it('注入:去重、未记录的也列出、超上限只发最近几条;没角色则不发', () => {
    const list = [entry('艾琳', 'A'), entry('艾琳', 'B', 1), entry('艾琳', 'C', 2)];
    const text = fmtKnowledgeInjection(list, ['艾琳', '小夏', '艾琳'], '林舟', 2);
    expect(text).toContain('角色对林舟的了解');
    expect(text).toContain('按其与林舟的关系本该知道的,照常知道');
    // 老存档清单是空的:剧情里交代过的照样算知道,免得老相识「失忆」
    expect(text).toContain('除非剧情里交代过该角色得知');
    expect(text).toContain('艾琳:(另有 1 条较早的从略)\n  - B\n  - C');
    expect(text).toContain('小夏:暂无记录');
    expect(text.match(/艾琳:/g)).toHaveLength(1);
    expect(fmtKnowledgeInjection(list, [], '林舟')).toBe('');
  });
  it('主模型注入只给主要角色和在场角色,受开关控制', () => {
    useChat([message({
      npcs: { add: [{ name: '艾琳', important: true }, { name: '小夏', follow: true }, { name: '路人甲' }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: '认定林舟是行商' }, { op: 'add', subject: '路人甲', text: '听说林舟有钱' }],
    })]);
    const text = inject.buildStateInjectionText();
    expect(text).toContain('艾琳:\n  - 认定林舟是行商');
    expect(text).toContain('小夏:暂无记录');
    expect(text).not.toContain('听说林舟有钱');
    settings.apiSettings.injection.knowledge = false;
    expect(inject.buildStateInjectionText()).not.toContain('角色对林舟的了解');
  });
});

describe('了解清单:实际摘要接线', () => {
  const setup = () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [message({ npcs: { add: [{ name: '艾琳', important: true }] },
      knowledge: [{ op: 'add', subject: '艾琳', text: '认定林舟是行商' }] }), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '林舟向艾琳坦白自己其实是王子,并报上了名字。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      knowledge: {
        update: [{ id: 'k1', text: '得知林舟其实是王子,此前一直被瞒' }],
        add: [{ who: '艾琳', text: '知道主角名叫林舟' }, { who: '林舟', text: '主角不记自己' }, { who: '路人', text: '名册外不记' }],
      },
    }));
    return chat;
  };
  const requestText = () => vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
  it('副 API 看到清单与规则,k 序号落成稳定 id,名册外与主角的条目丢弃', async () => {
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).toContain('【了解清单规则】');
    expect(requestText()).toContain('k1. 认定林舟是行商');
    // 检查清单的盘点项随开关一起发
    expect(requestText()).toContain('了解清单:对照「角色对主角的了解」');
    expect(chat[1].extra!.bbs_leaf!.delta.knowledge).toEqual([
      { op: 'update', id: knowledgeId(leafId(chat[0]), 0), text: '得知林舟其实是王子,此前一直被瞒' },
      { op: 'add', subject: '艾琳', text: '知道主角名叫林舟' },
    ]);
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['得知林舟其实是王子,此前一直被瞒', '知道主角名叫林舟']);
  });
  it('开关关闭:不发规则与清单,AI 硬给也不记,已有清单保留', async () => {
    settings.apiSettings.injection.knowledge = false;
    const chat = setup();
    await summarizeFloor(1);
    expect(requestText()).not.toContain('了解清单');
    expect(requestText()).not.toContain('认定林舟是行商');
    expect(chat[1].extra!.bbs_leaf!.delta.knowledge).toBeUndefined();
    expect(deriveMemory(chat).knowledge.map(k => k.text)).toEqual(['认定林舟是行商']);
  });
  it('正文点名只认两个字以上的名字:单字名几乎每段都能命中', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    second.mes = '林舟和小夏在客栈里说话。';
    useChat([message({ npcs: { add: [{ name: '艾琳', important: true }, { name: '小夏' }, { name: '舟' }] },
      knowledge: [{ op: 'add', subject: '小夏', text: '听说主角会医术' }, { op: 'add', subject: '舟', text: '听说主角是渔夫' }] }), second]);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '林舟和小夏闲聊。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
    }));
    await summarizeFloor(1);
    expect(requestText()).toContain('听说主角会医术');
    expect(requestText()).not.toContain('听说主角是渔夫');
  });
});
