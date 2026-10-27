import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { classifyNpcPresence, deriveMemory, editLeafFull, editNpc, finalizeDelta, setNpcFollow, upsertNpc } from './apply';
import { createNewChatWithCarryover } from './carryover';
import { currentSummaryPromise, summarizeFloor } from './engine';
import * as inject from './inject';
import { affinityLevelFromInput, applyNpcAffinity, cleanNpcAffinityLevel, fmtNpcAffinity, fmtNpcSummaryList, NPC_AFFINITY_BRIEFING, NPC_AFFINITY_FIELDS } from './npcRelations';
import { buildSummaryPrompt, RULE_NPC_AFFINITY } from './prompts';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type NpcAffinity, type NpcDelta, type StoredDelta, type SummaryDelta } from './types';

const name = '艾琳';
const initial: NpcDelta = { name, affinityInner: 1, affinityOuter: -1, affinityNote: '在意,但以冷淡掩饰', personality: '嘴硬、护短' };
const original = {
  summaryOnlyMode: settings.apiSettings.summaryOnlyMode,
  injection: { ...settings.apiSettings.injection },
  prompt: settings.apiSettings.prompts.summary,
  keepRecent: settings.apiSettings.keepRecent,
  vector: settings.apiSettings.vector.enabled,
};
let seq = 0;
const message = (delta: StoredDelta = {}): STMessage => ({
  name: 'Character', is_user: false, is_system: false, mes: '一段明确发生的剧情。',
  extra: { bbs_leaf: { id: `affinity-${++seq}`, text: '剧情摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});
const base = () => message({ npcs: { add: [{ ...initial }] } });
const patch = (values: Omit<NpcDelta, 'name'>) => message({ npcs: { update: [{ name, ...values }] } });
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: 'User', name2: 'Character',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'affinity-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.summaryOnlyMode = false;
  settings.apiSettings.injection.npcs = true;
  settings.apiSettings.injection.npcAffinity = true;
  settings.apiSettings.injection.scenes = true;
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
  settings.apiSettings.summaryOnlyMode = original.summaryOnlyMode;
  Object.assign(settings.apiSettings.injection, original.injection);
  settings.apiSettings.prompts.summary = original.prompt;
  settings.apiSettings.keepRecent = original.keepRecent;
  settings.apiSettings.vector.enabled = original.vector;
});

describe('定性档位与未知', () => {
  it.each([-2, -1, 0, 1, 2, null] as const)('保留有效值 %s', value => {
    expect(cleanNpcAffinityLevel(value)).toBe(value);
    const delta = finalizeDelta({ npcs: { add: [{ name, affinityInner: value }] } }, []);
    expect(deriveMemory([message(delta)]).npcs[0].affinityInner).toBe(value);
  });
  it.each([undefined, -3, 3, 50, 0.5, NaN, Infinity, '1', '', true, false, {}, []])('拒绝非法值 %j,不能转成中性或极值', value => {
    expect(cleanNpcAffinityLevel(value)).toBeUndefined();
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: value }] } } as unknown as SummaryDelta, []);
    expect(deriveMemory([base(), message(delta)]).npcs[0]).toMatchObject(initial);
  });
  it('下拉框空值是未知,零是中性;旧角色不凭空产生记录', () => {
    expect(affinityLevelFromInput('')).toBeNull();
    expect(affinityLevelFromInput('0')).toBe(0);
    expect(affinityLevelFromInput('-2')).toBe(-2);
    expect(fmtNpcAffinity({})).toBe('');
    expect(fmtNpcAffinity({ affinityInner: 0, affinityOuter: null })).toBe('内心好感:无明显好恶;外在态度:未知');
    expect(deriveMemory([message({ npcs: { add: [{ name }] } })]).npcs[0].affinityInner).toBeUndefined();
  });
  it('楼层只展示真正提供的字段,清空说明可见', () => {
    expect(fmtNpcAffinity({ affinityInner: 2 }, true)).toBe('内心好感:感情深厚');
    expect(fmtNpcAffinity({ affinityOuter: null }, true)).toBe('外在态度:未知');
    expect(fmtNpcAffinity({ affinityNote: '' }, true)).toBe('好感说明:清空');
    expect(fmtNpcAffinity({ affinityNote: '表面客套\n内心不信任' }, true)).toBe('说明:表面客套 内心不信任');
  });
});

describe('独立、绝对覆盖、可回滚的角色补丁', () => {
  it.each([
    [{ affinityInner: 2 }, 2, -1],
    [{ affinityOuter: 1 }, 1, 1],
    [{ affinityInner: -2, affinityOuter: 2 }, -2, 2],
    [{ affinityInner: null }, null, -1],
    [{ affinityOuter: 0 }, 1, 0],
    [{ title: '掌柜' }, 1, -1],
  ] as const)('补丁 %j 不联动另一侧', (values, inner, outer) => {
    const chat = [base(), patch(values)];
    expect(deriveMemory(chat).npcs[0]).toMatchObject({ affinityInner: inner, affinityOuter: outer, affinityNote: initial.affinityNote });
    expect(deriveMemory(chat)).toEqual(deriveMemory(chat));
  });
  it('没有好感补丁时,多轮普通互动保持档位和说明,不暗中累计', () => {
    const chat = [base(), ...Array.from({ length: 25 }, () => message({}))];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    expect(deriveMemory([...chat, patch({ affinityInner: 1 }), patch({ affinityInner: 1 })]).npcs[0].affinityInner).toBe(1);
  });
  it('重复 add 只补空缺,不覆盖已经建立的档位与说明', () => {
    const chat = [base(), message({ npcs: { add: [{ name, affinityInner: -2, affinityOuter: 2, affinityNote: '不应覆盖' }] } })];
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    const target: NpcAffinity = { affinityInner: null, affinityOuter: 0 };
    applyNpcAffinity(target, { affinityInner: 1, affinityOuter: 2 }, true);
    expect(target).toEqual({ affinityInner: 1, affinityOuter: 0 });
  });
  it('撤回未知与清空说明通过 JSON 存储后仍有效', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name, affinityInner: null, affinityNote: '' }] } }, []);
    const npc = deriveMemory([base(), message(JSON.parse(JSON.stringify(delta)))]).npcs[0];
    expect(npc).toMatchObject({ affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('遗漏、删除、切换 swipe 和重摘的截止点都不泄漏未来好感', () => {
    const changed = patch({ affinityInner: 2, affinityOuter: 2 });
    const chat = [base(), changed];
    expect(deriveMemory(chat, 1).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = true;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    changed.extra!.bbs_omit = false;
    changed.swipe_id = 1;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
    delete changed.extra!.bbs_leaf;
    expect(deriveMemory(chat).npcs[0]).toMatchObject(initial);
  });
  it('角色新增/校正/改名往返保留两侧,无关编辑不写入好感补丁', () => {
    const chat = [message(), message()];
    useChat(chat);
    expect(upsertNpc(initial)).toBe(true);
    expect(editNpc(name, { title: '新身份' })).toBe(true);
    const unrelated = chat[1].extra!.bbs_leaf!.delta.npcs!.update!.at(-1)!;
    expect(unrelated.affinityInner).toBeUndefined();
    expect(unrelated.affinityOuter).toBeUndefined();
    expect(editNpc(name, { name: '新名字' })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ name: '新名字', affinityInner: 1, affinityOuter: -1, affinityNote: initial.affinityNote });
    expect(editNpc('新名字', { name, affinityInner: null, affinityNote: '' })).toBe(true);
    expect(memory.npcs).toHaveLength(1);
    expect(memory.npcs[0]).toMatchObject({ name, affinityInner: null, affinityOuter: -1, affinityNote: '' });
  });
  it('编辑楼层可以清空说明且不把未提供的另一侧改成未知', () => {
    const chat = [base(), patch({ affinityInner: 2, affinityNote: '新的依据' })];
    useChat(chat);
    const delta: StoredDelta = { npcs: { update: [{ name, affinityInner: 0, affinityNote: '' }] } };
    expect(editLeafFull(1, { text: '剧情摘要', timeStart: '', timeEnd: '', delta })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 0, affinityOuter: -1, affinityNote: '' });
  });
});

describe('离场同步与在场对账', () => {
  const sceneLeaf = () => message({
    location: '房间', locationPath: ['城', '客栈', '房间'],
    scenes: { add: [{ path: ['城'], desc: '城市' }, { path: ['城', '客栈'], desc: '客栈' }, { path: ['城', '客栈', '房间'], desc: '房间' }, { path: ['城', '客栈', '厨房'], desc: '厨房' }] },
    npcs: { add: [
      { name: '厨师', location: '厨房' },
      { name: '同伴', follow: true },
      { name: '远客', location: '远方' },
    ] },
  });
  const at = (mem: ReturnType<typeof deriveMemory>, n: string) => mem.npcs.find(x => x.name === n)!;

  it('空字符串清掉旧地点(所在不明),不再判在场;JSON 往返保留清空语义', () => {
    const delta = finalizeDelta({ npcs: { update: [{ name: '厨师', follow: false, location: '' }] } }, []);
    const chat = [sceneLeaf(), message(JSON.parse(JSON.stringify(delta)))];
    const mem = deriveMemory(chat);
    expect(at(mem, '厨师')).toMatchObject({ follow: false });
    expect(at(mem, '厨师').location).toBeUndefined();
    expect(classifyNpcPresence(at(mem, '厨师'), mem.scenes, '房间', ['城', '客栈', '房间'])).toBe('absent');
    // 对照:未清空的远客仍按地点判定为不在场,同伴恒在场
    expect(classifyNpcPresence(at(mem, '远客'), mem.scenes, '房间', ['城', '客栈', '房间'])).toBe('absent');
    expect(classifyNpcPresence(at(mem, '同伴'), mem.scenes, '房间', ['城', '客栈', '房间'])).toBe('present');
    // 随行角色顺手写空 location(没有显式写 follow)不能取消随行:空串只清地点
    const guard = deriveMemory([sceneLeaf(), message(JSON.parse(JSON.stringify(finalizeDelta({ npcs: { update: [{ name: '同伴', location: '' }] } }, []))))]);
    expect(at(guard, '同伴').follow).toBe(true);
    expect(at(guard, '同伴').location).toBeUndefined();
    expect(classifyNpcPresence(at(guard, '同伴'), guard.scenes, '房间', ['城', '客栈', '房间'])).toBe('present');
    // 要离队必须显式 follow:false;此时即便不带 location,原先随行时被清掉的地点也让它判不在场
    const left = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: '同伴', follow: false, location: '' }] } })]);
    expect(classifyNpcPresence(at(left, '同伴'), left.scenes, '房间', ['城', '客栈', '房间'])).toBe('absent');
    const leftNoLoc = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: '同伴', follow: false }] } })]);
    expect(classifyNpcPresence(at(leftNoLoc, '同伴'), leftNoLoc.scenes, '房间', ['城', '客栈', '房间'])).toBe('absent');
    // 同一条补丁明确 follow:true 与空 location 同时出现时,随行优先(不能被空串反向取消)
    const keep = deriveMemory([sceneLeaf(), message({ npcs: { update: [{ name: '厨师', follow: true, location: '' }] } })]);
    expect(classifyNpcPresence(at(keep, '厨师'), keep.scenes, '房间', ['城', '客栈', '房间'])).toBe('present');
  });
  it('省略 location 保持旧值,不能把未提供当成清空', () => {
    const chat = [sceneLeaf(), message({ npcs: { update: [{ name: '厨师', follow: false }] } })];
    expect(at(deriveMemory(chat), '厨师').location).toBe('厨房');
  });
  it('手动编辑末尾空值=所在不明;改名继承所在地;取消随行不误清位置', () => {
    const chat = [message(), message()];
    useChat(chat);
    expect(upsertNpc({ name, location: '客栈' })).toBe(true);
    expect(memory.npcs[0].location).toBe('客栈');
    expect(editNpc(name, { location: '' })).toBe(true);
    expect(memory.npcs[0].location).toBeUndefined();
    expect(editNpc(name, { location: '厨房' })).toBe(true);
    expect(editNpc(name, { name: '新名字' })).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ name: '新名字', location: '厨房' });
    expect(setNpcFollow('新名字', false)).toBe(true);
    expect(memory.npcs[0]).toMatchObject({ follow: false, location: '厨房' });
    expect(editNpc('新名字', { location: '' })).toBe(true);
    expect(memory.npcs[0].location).toBeUndefined();
  });
  it('摘要名册按本楼之前的状态标在场,离场去向未明标所在不明', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [sceneLeaf(), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '厨师离开房间但没说去哪。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { update: [{ name: '厨师', follow: false, location: '' }] },
    }));
    await summarizeFloor(1);
    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(material).toContain('厨师〔同区域〕'); // 厨师在厨房:相对主角当前节点(房间)是同区域
    expect(material).toContain('同伴〔在场〕 [随行]');
    expect(material).toContain('远客〔不在场〕');
    expect(memory.npcs.find(n => n.name === '厨师')?.location).toBeUndefined();
    expect(classifyNpcPresence(memory.npcs.find(n => n.name === '厨师')!, memory.scenes, '房间', ['城', '客栈', '房间'])).toBe('absent');
  });
});

describe('名册在场标记渲染', () => {
  it('有 presence 时渲染标签;缺省保持旧格式,不引入所在不明', () => {
    const npc = { ...initial };
    expect(fmtNpcSummaryList([{ ...npc, presence: 'present', follow: true }])).toContain('〔在场〕 [随行]');
    expect(fmtNpcSummaryList([{ ...npc, presence: 'nearby', location: '厨房' }])).toContain('〔同区域〕 [在:厨房]');
    expect(fmtNpcSummaryList([{ ...npc, presence: 'absent' }])).toContain('〔不在场〕 [所在不明]');
    for (const mark of ['〔在场〕', '〔同区域〕', '〔不在场〕', '所在不明']) {
      expect(fmtNpcSummaryList([npc])).not.toContain(mark);
    }
  });
});

const promptArgs: Parameters<typeof buildSummaryPrompt>[0] = {
  user: 'User', char: 'Character', time: '', location: '', protagonist: {}, sceneFocus: null,
  lifeDetails: [], items: [], itemLog: [], scenes: [], npcs: [initial], openPlans: [], resolvedPlans: [],
  history: '先前事实', content: '这次只是普通交谈', hasTimeTags: true, varsState: {}, varsMeaning: '', varsRule: '',
};
describe('摘要与主对话的提示词边界', () => {
  it.each(['', 'CUSTOM {{content}}', 'CUSTOM {{npcs_block}} {{content}}'])('默认及自定义摘要模板都有协议与先前基线: %s', custom => {
    settings.apiSettings.prompts.summary = custom;
    const prompt = buildSummaryPrompt(promptArgs);
    expect(prompt.system).toContain('【内心好感与外在态度规则】');
    expect(prompt.system).not.toContain(initial.affinityNote);
    expect(prompt.user).toContain(fmtNpcSummaryList([initial]));
    expect(prompt.user.split('对主角的好感与态度估计[')).toHaveLength(2);
    expect(prompt.user).toContain('性格:嘴硬、护短');
  });
  it('明确默认稳定、内外独立、说明稳定及估计不能成为事实', () => {
    for (const contract of ['【默认保持,跨档才更新】', '【内外完全独立】', '【说明也要稳定】', '不是每轮重新打分',
      '两侧与说明均省略', '禁止增量', '禁止每轮升级修辞', '不要默认填 0', '不得把它抄入 summary/relation/ties/personality']) {
      expect(RULE_NPC_AFFINITY).toContain(contract);
    }
    // 估计是过去的总结,不是上限:防止主模型把旧档位当禁令冻结关系发展
    expect(NPC_AFFINITY_BRIEFING).toContain('不是对本轮的上限或禁令');
  });
  it('规则里的档位文字与界面档位一致', () => {
    // 好感规则截自 summary.txt,档位行写死在文件里;改了 NPC_AFFINITY_LABELS 须同步那里
    for (const f of NPC_AFFINITY_FIELDS) {
      const levels = f.options.filter(o => o.value !== '').map(o => `${o.value}=${o.label}`).join(';');
      expect(RULE_NPC_AFFINITY).toContain(`${f.label}(${f.key}):${levels}`);
    }
  });
  it('四档在场状态均注入独立好感,远处省略说明且守住角色视角', () => {
    const chat = [message({
      location: '房间', locationPath: ['城', '客栈', '房间'],
      scenes: { add: [{ path: ['城'], desc: '城市' }, { path: ['城', '客栈'], desc: '客栈' },
        { path: ['城', '客栈', '房间'], desc: '房间' }, { path: ['城', '客栈', '厨房'], desc: '厨房' }] },
      npcs: { add: [
        { ...initial, important: true },
        { name: '同伴', affinityInner: null, affinityOuter: 1, follow: true },
        { name: '厨师', affinityInner: -1, affinityOuter: 1, affinityNote: '保持礼貌', location: '厨房' },
        { name: '远客', affinityInner: -2, affinityOuter: 2, affinityNote: '远处说明不应注入', location: '远方' },
      ] },
    })];
    useChat(chat);
    const text = inject.buildStateInjectionText();
    expect(text.split(NPC_AFFINITY_BRIEFING)).toHaveLength(2);
    expect(text).toContain('内心好感:未知;外在态度:友善亲近');
    expect(text).toContain('内心好感:不喜欢;外在态度:友善亲近;说明:保持礼貌');
    expect(text).toContain('内心好感:强烈反感;外在态度:明显亲近、积极表达');
    expect(text).not.toContain('远处说明不应注入');
    expect(text).toContain('不代表主角或其他角色知情');
  });
  it('关闭「角色好感估计」后名册照发、好感不注入;摘要材料仍保留好感', () => {
    useChat([base()]);
    expect(inject.buildStateInjectionText()).toContain('好感估计');
    settings.apiSettings.injection.npcAffinity = false;
    const text = inject.buildStateInjectionText();
    expect(text).toContain('NPC名册');
    expect(text).toContain(name);
    expect(text).not.toContain('好感');
    expect(text).not.toContain('五档定性估计');
    // 副 API 摘要名册不受该开关影响:记录始终照常
    expect(buildSummaryPrompt(promptArgs).user).toContain('对主角的好感与态度估计[');
    settings.apiSettings.injection.npcAffinity = true;
    expect(inject.buildStateInjectionText()).toContain('好感估计');
  });
  it('旧角色无好感记录时零额外注入,关闭注入/纯摘要模式仍有效', () => {
    useChat([message({ npcs: { add: [{ name }] } })]);
    expect(inject.buildStateInjectionText()).not.toContain('好感');
    useChat([base()]);
    settings.apiSettings.injection.npcs = false;
    expect(inject.buildStateInjectionText()).not.toContain('内心好感');
    settings.apiSettings.injection.npcs = true;
    settings.apiSettings.summaryOnlyMode = true;
    expect(inject.buildStateInjectionText()).toBe('');
  });
});

describe('实际摘要入口与跨对话继承', () => {
  it('摘要用旧基线,解析 AI 的单侧更新,下一轮不变则保持', async () => {
    const second = message();
    delete second.extra!.bbs_leaf;
    const chat = [base(), second];
    useChat(chat);
    vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify({
      summary: '危急时她选择相救,但仍然嘴硬。', timeStart: '2026/9/13 10:00', timeEnd: '2026/9/13 10:05',
      npcs: { update: [{ name, affinityInner: 2, affinityNote: '相救表现出更深在意,外在仍冷淡' }] },
    }));
    await summarizeFloor(1);
    const request = vi.mocked(client.requestViaMainApi).mock.calls[0][0].map(m => m.content).join('\n');
    expect(request).toContain('内心好感:有好感;外在态度:冷淡疏远');
    expect(request).toContain('性格:嘴硬、护短');
    expect(chat[1].extra!.bbs_leaf!.delta.npcs!.update![0].affinityOuter).toBeUndefined();
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1 });
    const third = message(); delete third.extra!.bbs_leaf; chat.push(third);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ summary: '一起喝茶。', timeStart: '2026/9/13 10:05', timeEnd: '2026/9/13 10:10' }));
    await summarizeFloor(2);
    expect(memory.npcs[0]).toMatchObject({ affinityInner: 2, affinityOuter: -1, affinityNote: '相救表现出更深在意,外在仍冷淡' });
  });
  it('带数据创建新对话保留窗口前未知/中性和窗口内单侧更新,不改源聊天', async () => {
    settings.apiSettings.keepRecent = 1;
    const chat = [message({ npcs: { add: [{ name, affinityInner: null, affinityOuter: 0, affinityNote: '尚不知内心' }] } }), patch({ affinityOuter: 1 })];
    const source = useChat(chat);
    const before = JSON.stringify(chat);
    const target = { ...source, chat: [] as STMessage[], chatMetadata: {}, getCurrentChatId: () => 'affinity-carried' };
    vi.spyOn(context, 'getDoNewChat').mockResolvedValue(async () => {
      vi.mocked(context.getContext).mockReturnValue(target);
    });
    vi.spyOn(inject, 'refreshInjection').mockImplementation(() => {});
    expect(await createNewChatWithCarryover()).toBe(true);
    expect(JSON.stringify(chat)).toBe(before);
    expect(target.chat[0].extra!.bbs_leaf!.delta.npcs!.add![0]).toMatchObject({ name, affinityInner: null, affinityOuter: 0, affinityNote: '尚不知内心' });
    expect(deriveMemory(target.chat).npcs[0]).toMatchObject({ affinityInner: null, affinityOuter: 1, affinityNote: '尚不知内心' });
  });
});
