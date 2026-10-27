import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '@/api/client';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import * as notices from '@/st/toast';
import { batchBackfill, checkResummary, currentSummaryPromise, handleGenerationIntercept, openingPendingFloor, planBatches, summarizeFloor, summarizeSelected } from './engine';
import { buildBatchThinking, buildResummaryPrompt, buildSummaryThinking, RESUMMARY_THINKING_CHECKLIST, SUMMARY_OUTPUT_PROTOCOL } from './prompts';

/** 新提示词的成文顺序段落标记(替代旧 RULE_SUMMARY_COMPOSITION 常量)。 */
const COMPOSITION_HEADING = '【摘要成文顺序】';
import { renderSourceHints, SOURCE_HINTS_HEADER } from './sourceHints';
import { memory } from './store';
import { createEmptyMemory, type LeafExtra, type SummaryDelta } from './types';

const message = (isUser = false, overrides: Partial<STMessage> = {}): STMessage => ({
  name: isUser ? 'User' : 'Character',
  is_user: isUser,
  is_system: false,
  mes: isUser ? 'Start the story.' : 'The first response.',
  ...overrides,
});

const leaf = (): LeafExtra => ({
  id: 'first-page',
  text: 'An existing summary.',
  delta: {},
  createdAt: 0,
  swipe: 0,
  v: 1,
});

const summary = {
  summary: 'The story begins.',
  timeStart: '2026/9/7 10:00',
  timeEnd: '2026/9/7 10:05',
};

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  vi.spyOn(settings, 'engineActiveHere').mockReturnValue(true);
  vi.spyOn(settings, 'getChannelForTask').mockReturnValue(null);
  vi.spyOn(client, 'mainApiAvailable').mockReturnValue(true);
  vi.spyOn(client, 'requestViaMainApi').mockResolvedValue(JSON.stringify(summary));
  vi.spyOn(context, 'getCheckWorldInfo').mockResolvedValue(null);
  vi.spyOn(notices, 'toast').mockImplementation(() => {});
});

afterEach(async () => {
  await currentSummaryPromise();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function useChat(chat: STMessage[]) {
  vi.spyOn(context, 'getContext').mockReturnValue({
    chat,
    name1: 'User',
    name2: 'Character',
    getCurrentChatId: () => 'opening-regression',
  } as STContext);
}

describe('openingPendingFloor', () => {
  it.each([
    ['empty chat', [], -1],
    ['only the first user message', [message(true)], -1],
    ['a real greeting before the user', [message(), message(true)], 0],
    ['a response after the first user message', [message(true), message()], -1],
    ['an omitted user message before the response', [
      message(true, { extra: { bbs_omit: true } }), message(),
    ], -1],
    ['a system notice before a real greeting', [
      message(false, { is_system: true, extra: { type: 'narrator' } }), message(),
    ], 1],
    ['multiple AI messages', [message(), message(true), message()], -1],
    ['an already summarized greeting', [message(false, { extra: { bbs_leaf: leaf() } })], -1],
    ['a greeting with complete time tags', [message(false, {
      mes: `<bbs_start>${summary.timeStart}</bbs_start>Greeting<bbs_end>${summary.timeEnd}</bbs_end>`,
    })], -1],
    ['a greeting missing its end tag', [message(false, {
      mes: `<bbs_start>${summary.timeStart}</bbs_start>Greeting`,
    })], 0],
  ] as const)('%s', (_name, chat, expected) => {
    expect(openingPendingFloor([...chat])).toBe(expected);
  });
});

describe('opening generation interception', () => {
  it.each([
    ['swipe', false],
    ['regenerate', false],
    ['swipe', true],
    ['regenerate', true],
  ] as const)('does not summarize the rewritten last AI (%s, greeting=%s)', async (type, greeting) => {
    const ai = message(false, { swipe_id: 1, swipes: ['The first response.'] });
    const chat = greeting ? [ai] : [message(true), ai];
    useChat(chat);
    const before = structuredClone(chat);
    const abort = vi.fn();

    expect(await handleGenerationIntercept(type, abort)).toBe(false);

    expect(abort).not.toHaveBeenCalled();
    expect(notices.toast).not.toHaveBeenCalled();
    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(chat).toEqual(before);
    expect(memory.state.time).toBeFalsy();
  });

  it('does not attach the old page summary to the new swipe', async () => {
    const ai = message(false, {
      swipe_id: 1,
      swipes: ['The first response.'],
      extra: { bbs_leaf: leaf() },
    });
    const chat = [message(true), ai];
    useChat(chat);
    const before = structuredClone(chat);

    await handleGenerationIntercept('swipe', vi.fn());

    expect(client.requestViaMainApi).not.toHaveBeenCalled();
    expect(notices.toast).not.toHaveBeenCalled();
    expect(chat).toEqual(before);
  });

  it.each(['normal', 'swipe', 'regenerate'])(
    'still establishes a real greeting anchor when the last message is user (%s)',
    async type => {
      const chat = [message(), message(true)];
      useChat(chat);
      const abort = vi.fn();

      expect(await handleGenerationIntercept(type, abort)).toBe(false);

      expect(abort).not.toHaveBeenCalled();
      expect(notices.toast).toHaveBeenCalledOnce();
      expect(client.requestViaMainApi).toHaveBeenCalledOnce();
      expect(chat[0].extra?.bbs_leaf).toMatchObject({
        timeStart: summary.timeStart,
        timeEnd: summary.timeEnd,
        swipe: 0,
      });
    },
  );

  it('summarizes the first generated reply normally after the next user message', async () => {
    const chat = [message(true), message(), message(true)];
    useChat(chat);

    await handleGenerationIntercept('normal', vi.fn());
    await currentSummaryPromise();

    expect(notices.toast).not.toHaveBeenCalled();
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
  });
});

describe('summary request roles', () => {
  const originalPrompts = { ...settings.apiSettings.prompts };
  const originalBatch = {
    batchMaxFloors: settings.apiSettings.batchMaxFloors,
    batchMaxChars: settings.apiSettings.batchMaxChars,
  };

  beforeEach(() => {
    Object.assign(settings.apiSettings.prompts, { summary: '', resummary: '', resummary2: '' });
    Object.assign(settings.apiSettings, { batchMaxFloors: 2, batchMaxChars: 10000 });
  });

  afterEach(() => {
    Object.assign(settings.apiSettings.prompts, originalPrompts);
    Object.assign(settings.apiSettings, originalBatch);
  });

  it.each([false, true])('sends single-floor instructions separately and stores only final JSON (custom=%s)', async custom => {
    if (custom) settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const chat = [message()];
    useChat(chat);
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `<thinking>Source and coverage records.</thinking>${JSON.stringify(summary)}`,
    );

    await summarizeFloor(0);

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const all = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    // NVWA 独立核心集中在破限 system 位:整个请求恰好出现一次,其余消息不重复携带。
    expect(all.filter(m => m.content.includes('<nvwa_standalone_core>'))).toHaveLength(1);
    expect(all[0].content).toContain('<nvwa_standalone_core>');
    const tail = vi.mocked(client.requestViaMainApi).mock.calls[0][0].slice(-3);
    // 了解清单默认开启,清单带上其盘点项
    const thinking = buildSummaryThinking('User', true);
    expect(tail).toEqual([
      { role: 'system', content: expect.stringContaining(custom ? '【柏宝书主角档案兼容协议】' : '【物品规则】') },
      { role: 'user', content: expect.stringContaining('The first response.') },
      { role: 'system', content: thinking },
    ]);
    expect(tail[0].content).not.toContain('The first response.');
    expect(tail[1].content).toContain('[M1-P1] The first response.');
    // 已取消预填充:末尾是 system 检查清单,不再有 assistant 预填充
    expect(tail.at(-1)?.role).toBe('system');
    expect(thinking).toContain('<thinking>');
    expect(tail[1].content).not.toContain('═══ 【物品规则】');
    expect(tail[1].content).not.toContain(SOURCE_HINTS_HEADER);
    expect(tail.map(m => m.content).join('\n').split(COMPOSITION_HEADING)).toHaveLength(custom ? 1 : 2);
    expect(tail.map(m => m.content).join('\n').split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
    expect(chat[0].extra?.bbs_leaf?.text).toBe(summary.summary);
  });

  it('stores structured changes alongside a brief audit and summary', async () => {
    const chat = [message(false, {
      mes: 'User enters the stone Archive. Archivist gives User the brass vault key and agrees to meet on 2026/9/10 at 10:00.',
    })];
    useChat(chat);
    const changes = {
      location: 'Archive',
      locationPath: ['Archive'],
      sceneFocus: { situation: 'User meets Archivist in the Archive.', participants: ['User', 'Archivist'] },
      items: { add: [{ name: 'Vault key', desc: 'A brass key.', qty: 1, carried: true }] },
      scenes: { add: [{ path: ['Archive'], desc: 'A stone archive.' }] },
      npcs: { add: [{ name: 'Archivist', title: 'Keeper of the archive', location: 'Archive' }] },
      plans: { add: [{ kind: 'plan', content: 'Meet Archivist.', targetTime: '2026/9/10 10:00' }] },
    } satisfies SummaryDelta;
    const text = 'User entered the Archive, received its vault key and arranged a meeting with Archivist.';
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `<thinking>Key, place, contact and appointment recorded.</thinking>${JSON.stringify({ ...summary, summary: text, ...changes })}`,
    );

    await summarizeFloor(0);

    expect(chat[0].extra?.bbs_leaf).toMatchObject({ text, delta: changes });
    expect(memory.state).toMatchObject({
      location: changes.location, locationPath: changes.locationPath, sceneFocus: changes.sceneFocus,
    });
    expect(memory.items).toEqual([expect.objectContaining(changes.items.add[0])]);
    expect(memory.scenes).toHaveLength(1);
    expect(memory.scenes[0].desc).toBe(changes.scenes.add[0].desc);
    expect(memory.npcs).toEqual([expect.objectContaining(changes.npcs.add[0])]);
    expect(memory.plans).toEqual([expect.objectContaining(changes.plans.add[0])]);
    expect(JSON.stringify(chat[0].extra?.bbs_leaf)).not.toContain('Key, place, contact and appointment recorded.');
  });

  it.each(['\n', '\r\n'])('numbers cleaned source paragraphs without changing stored chat (newline=%j)', async newline => {
    const body = [
      '<thinking>Discarded audit.</thinking>',
      `<bbs_start>${summary.timeStart}</bbs_start>`,
      '<content>',
      'The first response.',
      '',
      ' \t',
      'The second paragraph.',
      '</content>',
      `<bbs_end>${summary.timeEnd}</bbs_end>`,
      'Discarded status panel.',
    ].join(newline);
    const chat = [message(true), message(false, { mes: body })];
    useChat(chat);

    await summarizeFloor(1);

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].at(-2)?.content ?? '';
    expect(material).toContain('【用户·User】\n[M1-P1] Start the story.');
    expect(material).toContain([
      '【角色·Character】',
      `[M2-P1] (起始时间:${summary.timeStart})`,
      '[M2-P2] <content>',
      '[M2-P3] The first response.',
      '[M2-P4] The second paragraph.',
      '[M2-P5] </content>',
      `[M2-P6] (结束时间:${summary.timeEnd})`,
    ].join('\n'));
    expect(material).not.toContain('Discarded');
    expect(material).not.toContain('[M2-P7]');
    expect(chat[0].mes).toBe('Start the story.');
    expect(chat[1].mes).toBe(body);
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
  });

  it.each([
    [false, '\n'], [false, '\r\n'], [true, '\n'], [true, '\r\n'],
  ] as const)('attaches verbatim reminders from cleaned user and AI paragraphs only (custom=%s, newline=%j)', async (custom, newline) => {
    if (custom) settings.apiSettings.prompts.summary = 'CUSTOM {{content}}';
    const userBody = '我已经搬出旧宿舍，独自住进条件更好的公寓。';
    const paragraphs = [
      '「谷口风速已经过了九级，气温降到零下三十三度。」',
      '「能见度不足三十米，红外热成像仪的探测距离会被压制在大半以内。」',
      '「风太大了，我的狙击铳很难锁定主峰高地！」',
      '「谷口两侧有暗坑，必须先放侦察蜂排查……」',
    ];
    const body = [
      '<thinking>无法使用的旧检查记录，不应进入提醒。</thinking>',
      `<bbs_start>${summary.timeStart}</bbs_start>`,
      '<content>',
      ...paragraphs,
      'The door opened.',
      '</content>',
      `<bbs_end>${summary.timeEnd}</bbs_end>`,
      '无法使用的状态栏，不应进入提醒。',
    ].join(newline);
    const chat = [message(true, { mes: userBody }), message(false, { mes: body })];
    useChat(chat);

    await summarizeFloor(1);

    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    const material = messages.at(-2)!.content;
    expect(material.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    const hints = material.split(SOURCE_HINTS_HEADER)[1];
    const expected = [
      `[M1-P1] ${userBody}`,
      ...paragraphs.map((text, index) => `[M2-P${index + 3}] ${text}`),
    ];
    for (const line of expected) {
      expect(hints.split(line)).toHaveLength(2);
      expect(material.split(SOURCE_HINTS_HEADER)[0]).toContain(line);
      expect(messages.filter(m => m.role === 'system').every(m => !m.content.includes(line))).toBe(true);
    }
    expect(hints).not.toContain('The door opened.');
    expect(material).not.toContain('不应进入提醒');
    expect(chat.map(m => m.mes)).toEqual([userBody, body]);
    expect(chat[1].extra?.bbs_leaf?.text).toBe(summary.summary);
    if (custom) expect(material).toContain('CUSTOM 【用户·User】');
  });

  it('does not select reminder sources from history or later turns', async () => {
    const history = '历史记录：旧设备无法使用。';
    const future = '未来消息：设备已经恢复正常。';
    const body = '本届联赛参赛者中最强的学生是二转巅峰。';
    const chat = [
      message(false, { extra: { bbs_leaf: { ...leaf(), text: history } } }),
      message(true),
      message(false, { mes: body }),
      message(false, { mes: future }),
    ];
    useChat(chat);

    await summarizeFloor(2);

    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].at(-2)!.content;
    const hints = material.split(SOURCE_HINTS_HEADER)[1];
    expect(material).toContain(history);
    expect(hints).toContain(`[M3-P1] ${body}`);
    expect(hints).not.toContain(history);
    expect(hints).not.toContain('[M1-');
    expect(material).not.toContain(future);
    expect(hints).not.toContain('[M4-');
  });

  it('includes source marker overhead when splitting batches by input size', () => {
    const chat = [message(false, { mes: Array(35).fill('a').join('\n') }), message(false, {
      mes: Array(35).fill('b').join('\n'),
    })];
    useChat(chat);

    expect(planBatches(chat, [0, 1], 500, 10)).toEqual([[0], [1]]);
  });

  it('includes copied reminder text when splitting batches by input size', () => {
    const body = '能见度不足三十米。'.repeat(8);
    const chat = [message(false, { mes: body }), message(false, { mes: body })];
    useChat(chat);
    expect((`【角色·Character】\n[M1-P1] ${body}`.length) * 2).toBeLessThan(500);

    expect(planBatches(chat, [0, 1], 500, 10)).toEqual([[0], [1]]);
  });

  it('includes preceding user paragraphs and their reminders in batch sizing', () => {
    const userBody = '我已经搬出旧居，生活条件改善了。'.repeat(6);
    const chat = [
      message(true, { mes: userBody }), message(),
      message(true, { mes: userBody }), message(),
    ];
    useChat(chat);

    expect(planBatches(chat, [1, 3], 500, 10)).toEqual([[1], [3]]);
    expect(planBatches(chat, [1, 3], 10000, 10)).toEqual([[1, 3]]);
  });

  it('sends batch instructions separately, retaining floor order and clean stored summaries', async () => {
    const chat = [
      message(true), message(),
      message(true, { mes: 'Continue the story.' }), message(false, { mes: 'The second response.' }),
    ];
    useChat(chat);
    const floors = [1, 2].map(n => ({ ...summary, n, summary: `Verified floor ${n}.` }));
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `<thinking>Per-floor source records.</thinking>${JSON.stringify({ floors })}`,
    );

    expect(await batchBackfill({ floors: [1, 3] })).toMatchObject({ done: 2, total: 2, cancelled: false });

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    // 批量请求过去是全局唯一漏掉 NVWA 核心的路径;确保破限位仍带核心且只带一次。
    const allBatch = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    expect(allBatch.filter(m => m.content.includes('<nvwa_standalone_core>'))).toHaveLength(1);
    expect(allBatch[0].content).toContain('<nvwa_standalone_core>');
    const tail = vi.mocked(client.requestViaMainApi).mock.calls[0][0].slice(-3);
    const thinking = buildBatchThinking(2);
    expect(tail).toEqual([
      { role: 'system', content: expect.stringContaining('长度必须等于 2') },
      { role: 'user', content: expect.stringContaining('The second response.') },
      { role: 'system', content: thinking },
    ]);
    expect(tail[0].content).not.toContain('The first response.');
    expect(tail[0].content).toContain(COMPOSITION_HEADING);
    expect(tail[1].content).not.toContain('【批量任务说明(关键)】');
    expect(tail[1].content).toContain('━━ 第 1 楼 ━━\n【用户·User】\n[M1-P1] Start the story.');
    expect(tail[1].content).toContain('[M2-P1] The first response.');
    expect(tail[1].content).toContain('━━ 第 2 楼 ━━\n【用户·User】\n[M3-P1] Continue the story.');
    expect(tail[1].content).toContain('[M4-P1] The second response.');
    expect(tail[1].content.match(/\[M\d+-P\d+\]/g)).toEqual(['[M1-P1]', '[M2-P1]', '[M3-P1]', '[M4-P1]']);
    expect(tail[1].content.indexOf('The first response.')).toBeLessThan(tail[1].content.indexOf('The second response.'));
    expect([chat[1], chat[3]].map(m => m.extra?.bbs_leaf?.text)).toEqual(floors.map(f => f.summary));
  });

  it('keeps each batch reminder inside its own floor with original message IDs', async () => {
    const bodies = ['风速超过九级，气温降到零下三十三度。', '她已经搬出旧居，生活条件改善了。'];
    const chat = [
      message(true), message(false, { mes: bodies[0] }),
      message(true), message(false, { mes: bodies[1] }),
    ];
    useChat(chat);
    const floors = [1, 2].map(n => ({ ...summary, n, summary: `Verified floor ${n}.` }));
    vi.mocked(client.requestViaMainApi).mockResolvedValue(JSON.stringify({ floors }));

    expect(await batchBackfill({ floors: [1, 3] })).toMatchObject({ done: 2 });

    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const material = vi.mocked(client.requestViaMainApi).mock.calls[0][0].at(-2)!.content;
    const [first, second] = material.split('━━ 第 2 楼 ━━');
    expect(first.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    expect(second.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    expect(first.split(SOURCE_HINTS_HEADER)[1]).toContain(`[M2-P1] ${bodies[0]}`);
    expect(first).not.toContain('[M4-P1]');
    expect(second.split(SOURCE_HINTS_HEADER)[1]).toContain(`[M4-P1] ${bodies[1]}`);
    expect(second).not.toContain('[M2-P1]');
    expect([chat[1], chat[3]].map(m => m.mes)).toEqual(bodies);
    expect([chat[1], chat[3]].map(m => m.extra?.bbs_leaf?.text)).toEqual(floors.map(f => f.summary));
  });
});

describe.each(['automatic', 'manual'] as const)('compression audit output (%s)', mode => {
  const originalPrompts = { ...settings.apiSettings.prompts };
  const original = {
    leafBatchThreshold: settings.apiSettings.leafBatchThreshold,
    leafKeepRecent: settings.apiSettings.leafKeepRecent,
    resummaryThreshold: settings.apiSettings.resummaryThreshold,
    higherResummaryThreshold: settings.apiSettings.higherResummaryThreshold,
    summaryMaxRetries: settings.apiSettings.summaryMaxRetries,
  };

  beforeEach(() => {
    Object.assign(settings.apiSettings.prompts, { resummary: '', resummary2: '' });
    Object.assign(settings.apiSettings, {
      leafBatchThreshold: 2,
      leafKeepRecent: 0,
      resummaryThreshold: 2,
      higherResummaryThreshold: 2,
      summaryMaxRetries: 0,
    });
  });

  afterEach(() => {
    Object.assign(settings.apiSettings.prompts, originalPrompts);
    Object.assign(settings.apiSettings, original);
  });

  function seedInputs(level: number, texts?: string[]): string[] {
    const chat = [0, 1].map(index => message(false, {
      extra: { bbs_leaf: { ...leaf(), id: `leaf-${index}`, text: texts?.[index] ?? leaf().text, createdAt: index } },
    }));
    useChat(chat);
    if (level === 0) return ['leaf-0', 'leaf-1'];
    memory.summaries.push(...[0, 1].map(index => ({
      id: `input-${index}`,
      text: texts?.[index] ?? `Earlier summary ${index}.`,
      level,
      createdAt: index,
      auto: true,
      childIds: [`leaf-${index}`],
    })));
    return ['input-0', 'input-1'];
  }

  async function compress(ids: string[]) {
    return mode === 'automatic' ? checkResummary() : (await summarizeSelected(ids)).made;
  }

  it.each([0, 1, 2])('sends a checklist, storing only final data (input level=%s)', async level => {
    const ids = seedInputs(level);
    const finalSummary = 'The confirmed merged facts.';
    // 模型自行打开 <thinking> 检查块（不再有预填充）。
    vi.mocked(client.requestViaMainApi).mockResolvedValue(
      `F1 | source 1 | confirmed fact\nCoverage: F1 | confirmed merged facts\n</thinking>\n${JSON.stringify({ summary: finalSummary })}`,
    );

    expect(await compress(ids)).toBe(1);
    expect(client.requestViaMainApi).toHaveBeenCalledOnce();
    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    expect(messages.slice(-3)).toEqual([
      { role: 'system', content: expect.stringContaining('{ "summary":') },
      expect.objectContaining({ role: 'user' }),
      { role: 'system', content: RESUMMARY_THINKING_CHECKLIST },
    ]);
    const sourceText = level === 0 ? 'An existing summary.' : 'Earlier summary 0.';
    expect(messages.at(-2)?.content).toContain(sourceText);
    expect(messages.at(-2)?.content).toContain(`[1] ${sourceText}`);
    expect(messages.at(-2)?.content).toContain('[2] ');
    expect(messages.at(-2)?.content).not.toMatch(/\[M\d+-P\d+\]/);
    expect(messages.at(-3)?.content).not.toContain(sourceText);
    expect(messages.at(-3)?.content).toContain(COMPOSITION_HEADING);
    expect(messages.at(-2)?.content).not.toContain('【输出要求】');
    expect(messages.at(-2)?.content).not.toContain(SOURCE_HINTS_HEADER);
    expect(messages.map(m => m.content).join('\n').split(SUMMARY_OUTPUT_PROTOCOL)).toHaveLength(2);
    const saved = memory.summaries.at(-1);
    expect(saved).toMatchObject({ text: finalSummary, level: level + 1, childIds: ids });
    expect(JSON.stringify(saved)).not.toContain('Coverage:');
  });

  it.each([
    [0, false], [1, false], [2, false], [1, true],
  ] as const)('copies numbered sources with time ranges without inflating budgets (input level=%s, custom=%s)', async (level, custom) => {
    if (custom) {
      settings.apiSettings.prompts.resummary2 = 'CUSTOM {{content}}\nBUDGET {{target_min}}-{{target_max}}';
    }
    const texts = [
      '本段能见度不足三十米，红外探测距离受限。',
      '她已经搬出旧居，生活条件改善了。',
    ];
    const ids = seedInputs(level, texts);
    const inputs = level === 0
      ? context.getContext()!.chat.map(m => m.extra!.bbs_leaf!)
      : [...memory.summaries];
    for (const input of inputs) {
      input.timeStart = summary.timeStart;
      input.timeEnd = summary.timeEnd;
    }
    const sources = texts.map((text, index) => ({
      source: `[${index + 1}]`,
      text: `(${summary.timeStart} – ${summary.timeEnd}) ${text}`,
    }));
    const content = sources.map(({ source, text }) => `${source} ${text}`).join('\n\n');
    const expected = buildResummaryPrompt({ user: 'User', char: 'Character', content, level: level + 1 });

    expect(await compress(ids)).toBe(1);

    const messages = vi.mocked(client.requestViaMainApi).mock.calls[0][0];
    expect(messages.at(-3)?.content).toBe(expected.system);
    expect(messages.at(-2)?.content).toBe(expected.user + renderSourceHints(sources));
    expect(messages.at(-2)?.content.split(SOURCE_HINTS_HEADER)).toHaveLength(2);
    expect(messages.at(-2)?.content).not.toMatch(/\[M\d+-P\d+\]/);
    expect(inputs.map(input => input.text)).toEqual(texts);
    expect(memory.summaries.at(-1)?.text).toBe(summary.summary);
    expect(messages.at(-1)?.content).toBe(RESUMMARY_THINKING_CHECKLIST);
    if (custom) {
      expect(messages.at(-2)?.content).toContain('CUSTOM ');
      expect(settings.apiSettings.prompts.resummary2).toBe('CUSTOM {{content}}\nBUDGET {{target_min}}-{{target_max}}');
    }
  });

  it('does not save JSON embedded in an unfinished audit', async () => {
    const ids = seedInputs(0);
    vi.mocked(client.requestViaMainApi).mockResolvedValue('<thinking>{"summary":"unfinished audit"}');

    expect(await compress(ids)).toBe(0);
    expect(memory.summaries).toHaveLength(0);
  });
});
