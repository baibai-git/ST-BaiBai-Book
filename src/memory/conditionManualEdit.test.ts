import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { deriveMemory, editNpc, editPlan, editSceneDesc, finalizeDelta, getLeaf, reparentScene, setProtagonist } from './apply';
import { memory, recomputeDerived } from './store';
import { createEmptyMemory, type StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '一段剧情。',
  extra: { bbs_leaf: { id: `manual-${++seq}`, text: '摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});
function useChat(chat: STMessage[]) {
  const ctx = { chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined), reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'manual-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}
const originalVector = settings.apiSettings.vector.enabled;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.vector.enabled = false;
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.vector.enabled = originalVector;
});

describe('手动覆盖主角状态时旧 conditionPatch 必须作废', () => {
  // 同一对象里 condition 与补丁同给时清洗层已以全文为准,故补丁放在后一楼(旧存档的形态)
  it('AI 叶子带补丁,手动改写后以手动值为准', () => {
    const ctx = useChat([
      message({ protagonist: { condition: '手臂受伤,夹板固定；自述还需休养三天' } }),
      message({ protagonist: { conditionPatch: { add: [{ text: '新扭伤脚踝' }] } } }),
    ]);
    expect(memory.protagonist.condition).toBe('手臂受伤,夹板固定；自述还需休养三天；新扭伤脚踝');
    expect(setProtagonist({ condition: '手臂受伤,已恢复' })).toBe(true);
    expect(memory.protagonist.condition).toBe('手臂受伤,已恢复');
    // 重放(而非仅内存)也不该把旧补丁加回来
    expect(deriveMemory(ctx.chat).protagonist.condition).toBe('手臂受伤,已恢复');
  });

  it('清空状态时补丁不得复活旧片段', () => {
    useChat([
      message({ protagonist: { condition: '手臂受伤；需休养' } }),
      message({ protagonist: { conditionPatch: { add: [{ text: '新扭伤脚踝' }] } } }),
    ]);
    expect(setProtagonist({ condition: '' })).toBe(true);
    expect(memory.protagonist.condition).toBeUndefined();
  });
});

describe('NPC 即时层支持手动清空', () => {
  it('清空 condition / outfit 生效', () => {
    useChat([message({ npcs: { add: [{ name: '艾琳', condition: '左肩中箭；不能拉弓', outfit: '染血披风' }] } })]);
    expect(memory.npcs[0].condition).toBe('左肩中箭；不能拉弓');
    expect(editNpc('艾琳', { condition: '', outfit: '' })).toBe(true);
    expect(memory.npcs[0].condition).toBeUndefined();
    expect(memory.npcs[0].outfit).toBeUndefined();
  });
});

describe('NPC 档案层空字符串=清除', () => {
  const ARCHIVE = { gender: '女', age: '19', relation: '林舟的师姐', ties: '与店主是旧识', title: '旅店掌柜', desc: '银发及腰', personality: '爱逞强' };

  it('AI 用空串清掉错填的外貌/关系/身份;没教清除的性别给空串只当占位', () => {
    const clear = finalizeDelta({ npcs: { update: [{ name: '艾琳', desc: '', relation: '', title: '', gender: '' }] } }, []);
    const npc = deriveMemory([
      message({ npcs: { add: [{ name: '艾琳', ...ARCHIVE }] } }),
      message(JSON.parse(JSON.stringify(clear))),
    ]).npcs[0];
    expect(npc.desc).toBeUndefined();
    expect(npc.relation).toBeUndefined();
    expect(npc.title).toBeUndefined();
    expect(npc.gender).toBe('女');
  });

  it('手动删空全部档案字段(含年龄)生效,重放同样生效', () => {
    const ctx = useChat([message({ npcs: { add: [{ name: '艾琳', ...ARCHIVE }] } })]);
    expect(editNpc('艾琳', { gender: '', age: '', relation: '', ties: '', title: '', desc: '', personality: '' })).toBe(true);
    for (const npc of [memory.npcs[0], deriveMemory(ctx.chat).npcs[0]]) {
      for (const key of ['gender', 'age', 'ageTime', 'relation', 'ties', 'title', 'desc', 'personality'] as const) {
        expect(npc[key]).toBeUndefined();
      }
    }
  });
});

describe('地点描述可手动清空', () => {
  it('删空只清描述、节点保留;换上级时删空同样生效', () => {
    const ctx = useChat([message({ scenes: { ops: [
      { op: 'add', path: ['王都'], desc: '王国首都' },
      { op: 'add', path: ['王都', '酒馆'], desc: '吵闹的小酒馆' },
      { op: 'add', path: ['港口'], desc: '海边码头' },
    ] } })]);
    expect(editSceneDesc(['王都'], '')).toBe(true);
    // 换上级时删空:清除与 reparent 同一批写入,不会移了树却没清成
    expect(reparentScene(['王都', '酒馆'], ['港口', '酒馆'], { 酒馆: '' })).toBe(true);
    expect(getLeaf(ctx.chat[0])!.delta.scenes!.ops!.slice(-2).map(o => o.op)).toEqual(['reparent', 'update']);
    for (const scenes of [memory.scenes, deriveMemory(ctx.chat).scenes]) {
      const capital = scenes.find(s => s.name === '王都');
      const tavern = scenes.find(s => s.name === '酒馆');
      expect(capital).toBeDefined();
      expect(capital?.desc).toBeUndefined();
      expect(tavern?.path).toEqual(['港口', '酒馆']);
      expect(tavern?.desc).toBeUndefined();
    }
  });
});

describe('手动编辑计划不被后续楼层的 AI update 盖掉', () => {
  it('改内容/期限后,内存与重放都以手动值为准;连续两次编辑不互相冲掉', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: '三日后决斗', targetTime: '1988/10/1' }] } });
    const pid = `plan:${getLeaf(first)!.id}#0`;
    const ctx = useChat([first, message({ plans: { update: [{ id: pid, content: '五日后决斗', targetTime: '1988/10/3' }] } })]);
    expect(memory.plans[0].content).toBe('五日后决斗');

    expect(editPlan(pid, { content: '七日后决斗', targetTime: '1988/10/7' })).toBe(true);
    expect(memory.plans[0].content).toBe('七日后决斗');
    expect(memory.plans[0].targetTime).toBe('1988/10/7');

    expect(editPlan(pid, { content: '七日后决斗', targetTime: '1988/10/8' })).toBe(true);
    const replayed = deriveMemory(ctx.chat).plans[0];
    expect(replayed.content).toBe('七日后决斗');
    expect(replayed.targetTime).toBe('1988/10/8');
  });

  it('没有后续 update 时只原地改,不往最新叶子追加 update', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: '三日后决斗' }] } });
    const ctx = useChat([first]);
    expect(editPlan(`plan:${getLeaf(first)!.id}#0`, { content: '五日后决斗', targetTime: '' })).toBe(true);
    expect(memory.plans[0].content).toBe('五日后决斗');
    expect(getLeaf(ctx.chat[0])!.delta.plans?.update).toBeUndefined();
  });
});
