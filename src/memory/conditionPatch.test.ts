import { describe, expect, it } from 'vitest';
import { applyConditionPatch, splitConditionFragments, stripConditionFragmentIds } from './conditionPatch';
import { deriveMemory, finalizeDelta } from './apply';
import type { STMessage } from '@/st/context';
import type { StoredDelta } from './types';

let seq = 0;
const message = (delta: StoredDelta): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: '一段明确发生的剧情。',
  extra: { bbs_leaf: { id: `cond-${++seq}`, text: '剧情摘要', delta, createdAt: seq, swipe: 0, v: 1 } },
});

describe('conditionPatch 片段切分', () => {
  it('按分号/句号/换行切,逗号不切', () => {
    expect(splitConditionFragments('手臂受伤,夹板固定,暂不能提重物；自述还需休养几天。左腿擦伤'))
      .toEqual(['手臂受伤,夹板固定,暂不能提重物', '自述还需休养几天', '左腿擦伤']);
  });

  it('旧存档抄进的 [cN] 前缀不算内容,多层也剥净', () => {
    expect(splitConditionFragments('[c1] [c1] 手臂受伤；【c2】需休养')).toEqual(['手臂受伤', '需休养']);
    expect(stripConditionFragmentIds('[c1] 手臂受伤；[c2] [c2] 需休养')).toBe('手臂受伤；需休养');
    // 正文里的普通方括号不动
    expect(stripConditionFragmentIds('手臂受伤[轻]；需休养')).toBe('手臂受伤[轻]；需休养');
  });
});

describe('applyConditionPatch', () => {
  it('replace 只改指定编号,未列入的旧片段保留', () => {
    const next = applyConditionPatch('手臂受伤,夹板固定；自述还需休养几天；左腿擦伤', {
      replace: [{ id: 'c2', text: '休养结束,可正常活动' }],
    });
    expect(next).toBe('手臂受伤,夹板固定；休养结束,可正常活动；左腿擦伤');
  });

  it('replace 空串删除该片段,add 追加尾部', () => {
    const next = applyConditionPatch('手臂受伤；左腿擦伤', {
      replace: [{ id: 'c1', text: '' }],
      add: [{ text: '新扭伤脚踝' }],
    });
    expect(next).toBe('左腿擦伤；新扭伤脚踝');
  });

  it('全部片段清空后返回 undefined', () => {
    expect(applyConditionPatch('手臂受伤', { replace: [{ id: 'c1', text: '' }] })).toBeUndefined();
  });

  it('同一补丁删两段:编号按施加前算,不因前一条删除而错位', () => {
    const next = applyConditionPatch('手臂受伤,夹板固定；需休养三天；左腿擦伤', {
      replace: [{ id: 'c1', text: '' }, { id: 'c3', text: '' }],
    });
    expect(next).toBe('需休养三天');
  });

  it('删一段 + 改一段:改的是原 c2,c3 原样保留', () => {
    const next = applyConditionPatch('手臂受伤,夹板固定；需休养三天；左腿擦伤', {
      replace: [{ id: 'c1', text: '' }, { id: 'c2', text: '休养结束,可提轻物' }],
    });
    expect(next).toBe('休养结束,可提轻物；左腿擦伤');
  });

  it('越界编号不影响其他片段', () => {
    expect(applyConditionPatch('手臂受伤；需休养三天', { replace: [{ id: 'c9', text: '' }] })).toBe('手臂受伤；需休养三天');
  });

  it('text 带句号按片段切开,完全重复的不再挂第二遍', () => {
    const next = applyConditionPatch('手臂受伤；需休养', { add: [{ text: '需休养' }, { text: '左腿擦伤。仅留疤' }] });
    expect(next).toBe('手臂受伤；需休养；左腿擦伤；仅留疤');
  });
});

describe('新输出改回全文覆盖', () => {
  it('模型再给 conditionPatch 也不收,不会原样入库', () => {
    expect(finalizeDelta({ protagonist: { conditionPatch: { add: [{ text: '新扭伤脚踝' }] } } } as never, []).protagonist).toBeUndefined();
    const out = finalizeDelta({ npcs: { update: [{ name: '艾琳', conditionPatch: { replace: [{ id: 'c1', text: '' }] } }] } } as never, []);
    expect(out.npcs?.update?.[0]?.conditionPatch).toBeUndefined();
  });

  it('condition 给全文即整段覆盖', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: '手臂受伤；需休养三天' } }),
      message(finalizeDelta({ protagonist: { condition: '手臂受伤；脚踝扭伤' } } as never, [])),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('手臂受伤；脚踝扭伤');
  });
});

describe('旧存档 conditionPatch 照常重放', () => {
  it('主角已有伤情时按编号局部更新,不整段覆盖', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: '手臂受伤,夹板固定；自述还需休养几天' } }),
      message({ protagonist: { conditionPatch: { replace: [{ id: 'c2', text: '休养结束,可正常活动' }] } } }),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('手臂受伤,夹板固定；休养结束,可正常活动');
  });

  it('NPC 已有伤情时局部更新,并保留其他角色限制', () => {
    const chat: STMessage[] = [
      message({ npcs: { add: [{ name: '艾琳', condition: '左肩中箭；不能拉弓' }] } }),
      message({ npcs: { update: [{ name: '艾琳', conditionPatch: { replace: [{ id: 'c2', text: '已能轻微拉弓' }] } }] } }),
    ];
    const npc = deriveMemory(chat).npcs.find(n => n.name === '艾琳');
    expect(npc?.condition).toBe('左肩中箭；已能轻微拉弓');
  });

  it('同给全文与补丁的叶子,以全文为准', () => {
    const chat: STMessage[] = [
      message({ protagonist: { condition: '手臂受伤；需休养三天；左腿擦伤' } }),
      message({ protagonist: { condition: '手臂已痊愈；脚踝扭伤', conditionPatch: { replace: [{ id: 'c2', text: '休养结束' }] } } }),
    ];
    expect(deriveMemory(chat).protagonist.condition).toBe('手臂已痊愈；脚踝扭伤');
  });

  it('condition 里抄进的编号,重放时剥掉', () => {
    const chat: STMessage[] = [message({ npcs: { add: [{ name: '艾琳', condition: '[c1] 左肩中箭；[c2] 不能拉弓' }] } })];
    expect(deriveMemory(chat).npcs[0].condition).toBe('左肩中箭；不能拉弓');
  });
});

describe('NPC 定位不再要求 locationEvidence', () => {
  const npcLoc = (extra: Record<string, unknown> = {}) =>
    ({ npcs: { update: [{ name: '艾琳', location: '钟楼', ...extra }] } } as never);

  it('不带证据的定位照收', () => {
    const out = finalizeDelta(npcLoc(), []);
    expect(out.npcs?.update?.[0].location).toBe('钟楼');
  });

  it('旧习惯多给的 locationEvidence 不入库', () => {
    const out = finalizeDelta(npcLoc({ locationEvidence: '她走进钟楼' }), []);
    expect(out.npcs?.update?.[0].location).toBe('钟楼');
    expect(out.npcs?.update?.[0]).not.toHaveProperty('locationEvidence');
  });

  it('空 location(去向不明)→ 清除', () => {
    const out = finalizeDelta({ npcs: { update: [{ name: '艾琳', location: '' }] } } as never, []);
    expect(out.npcs?.update?.[0].location).toBe('');
  });
});

describe('scenes 建点宽、描述严', () => {
  it('add 不带 desc 也建节点,中间级自动补建', () => {
    const out = finalizeDelta({ scenes: { add: [{ path: ['王都', '城西区', '归雁客栈'] }] } } as never, []);
    expect(out.scenes?.add).toEqual([{ path: ['王都', '城西区', '归雁客栈'] }]);
    const scenes = deriveMemory([message(out)]).scenes;
    expect(scenes.map(s => s.path.join('/')).sort()).toEqual(['王都', '王都/城西区', '王都/城西区/归雁客栈']);
    expect(scenes.every(s => !s.desc)).toBe(true);
  });

  it('update 给空串 → 清除错填描述,节点保留', () => {
    const chat: STMessage[] = [
      message({ scenes: { add: [{ path: ['码头'], desc: '今天下雨,人很多' }] } }),
      message(finalizeDelta({ scenes: { update: [{ path: ['码头'], desc: '' }] } } as never, [])),
    ];
    const scenes = deriveMemory(chat).scenes;
    expect(scenes).toHaveLength(1);
    expect(scenes[0].desc).toBeUndefined();
  });

  it('add 不覆盖已有描述,update 才覆盖', () => {
    const chat: STMessage[] = [
      message({ scenes: { add: [{ path: ['码头'], desc: '城西的货运码头' }] } }),
      message({ scenes: { add: [{ path: ['码头'] }, { path: ['码头'], desc: '另一种说法' }] } }),
    ];
    expect(deriveMemory(chat).scenes[0].desc).toBe('城西的货运码头');
    chat.push(message({ scenes: { update: [{ path: ['码头'], desc: '城西的货运码头,后被焚毁' }] } }));
    expect(deriveMemory(chat).scenes[0].desc).toBe('城西的货运码头,后被焚毁');
  });

  it('update 不带 desc → 无事可做,丢弃', () => {
    const out = finalizeDelta({ scenes: { update: [{ path: ['码头'] }] } } as never, []);
    expect(out.scenes).toBeUndefined();
  });

  it('对不存在的地点 update 空串 → 不凭空建点', () => {
    expect(deriveMemory([message({ scenes: { update: [{ path: ['码头'], desc: '' }] } })]).scenes).toHaveLength(0);
  });
});

describe('plans.update', () => {
  it('finalizeDelta 把短序号翻译成稳定 id', () => {
    const out = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/5' }] } } as never,
      [{ id: 'plan:leaf#0' }],
    );
    expect(out.plans?.update).toEqual([{ id: 'plan:leaf#0', targetTime: '1988/10/5' }]);
  });

  it('显式 locationPath: [] 清除旧锚点,不继承旧归属', () => {
    const out = finalizeDelta({ location: 'in transit', locationPath: [] } as never, []);
    expect(out.locationPath).toEqual([]);
  });

  it('没有 location 时单独的空 locationPath 不清锚点,有效路径照常保存', () => {
    for (const locationPath of [[], null, '']) {
      expect(finalizeDelta({ locationPath } as never, []).locationPath).toBeUndefined();
    }
    expect(finalizeDelta({ locationPath: ['王城', '钟楼'] } as never, []).locationPath).toEqual(['王城', '钟楼']);
    const anchored = message({ location: '钟楼', locationPath: ['王城', '钟楼'] });
    const derived = deriveMemory([anchored, message(finalizeDelta({ locationPath: [] } as never, []))]);
    expect(derived.state.locationPath).toEqual(['王城', '钟楼']);
  });

  it('改期后覆盖 targetTime,旧 content 保留', () => {
    const first = message({ plans: { add: [{ kind: 'plan', content: '三日后决斗', targetTime: '1988/10/1' }] } });
    const opened = deriveMemory([first]).plans;
    const finalized = finalizeDelta(
      { plans: { update: [{ id: 'p1', targetTime: '1988/10/9' }] } } as never,
      opened,
    );
    const derived = deriveMemory([first, message(finalized)]);
    expect(derived.plans[0].targetTime).toBe('1988/10/9');
    expect(derived.plans[0].content).toBe('三日后决斗');
  });
});
