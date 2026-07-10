import { derivedMeta, memory } from '@/memory/store';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import { watch } from 'vue';
import {
  bumpPublicRevision,
  clonePublic,
  getContextAtFloor,
  getFloor,
  getHistory,
  getInjectedHistory,
  getPublicRevision,
  getSnapshot,
  getVar,
  PUBLIC_API_VERSION,
  query,
} from './query';
import type {
  HistoryOptions,
  PublicCapabilities,
  PublicChangeListener,
  PublicChangeNotice,
  PublicFloor,
  PublicFloorContext,
  PublicHistory,
  PublicInjectedHistory,
  PublicQueryRequest,
  PublicQueryResult,
  PublicSnapshot,
  SnapshotAt,
  SnapshotOptions,
  STBaiBaiBookApi,
} from './types';

export const PUBLIC_READY_EVENT = 'st-baibai-book:ready';
export const PUBLIC_CHANGED_EVENT = 'st-baibai-book:changed';

const capabilities: PublicCapabilities = {
  globalApi: true,
  slashCommand: false,
  macros: false,
  parameterizedMacros: false,
  events: true,
};

const listeners = new Set<PublicChangeListener>();
let registered = false;
let ready = false;
let changeQueued = false;

function chatId(): string | null {
  return getContext()?.getCurrentChatId?.() ?? null;
}

function notice(type: PublicChangeNotice['type']): PublicChangeNotice {
  return {
    type,
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chatId: chatId(),
    capabilities: clonePublic(capabilities),
  };
}

function emitNotice(type: PublicChangeNotice['type']): void {
  const detail = notice(type);
  for (const listener of listeners) {
    try {
      listener(clonePublic(detail));
    } catch (error) {
      console.warn('[柏宝书] 公共 API 订阅回调异常', error);
    }
  }
  const eventName = type === 'ready' ? PUBLIC_READY_EVENT : PUBLIC_CHANGED_EVENT;
  window.dispatchEvent(new CustomEvent(eventName, { detail: clonePublic(detail) }));
}

function queueChangedNotice(): void {
  if (changeQueued) return;
  changeQueued = true;
  queueMicrotask(() => {
    changeQueued = false;
    bumpPublicRevision();
    if (ready) emitNotice('changed');
  });
}

function bindPublicChangeEvents(): void {
  const ctx = getContext();
  const eventSource = ctx?.eventSource;
  const eventTypes = ctx?.eventTypes;
  if (!eventSource || !eventTypes) return;
  const names = new Set([
    eventTypes.CHAT_CHANGED,
    eventTypes.USER_MESSAGE_RENDERED,
    eventTypes.CHARACTER_MESSAGE_RENDERED,
    eventTypes.MESSAGE_SENT,
    eventTypes.MESSAGE_SWIPED,
    eventTypes.MESSAGE_DELETED,
    eventTypes.MESSAGE_EDITED,
    eventTypes.MESSAGE_UPDATED,
  ].filter((name): name is string => typeof name === 'string' && !!name));
  for (const name of names) eventSource.on(name, queueChangedNotice);
}

function createApi(): STBaiBaiBookApi {
  return Object.freeze({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    get capabilities() {
      return clonePublic(capabilities);
    },
    getVar: (path: string, options?: SnapshotOptions) => getVar(path, options),
    getSnapshot: (options?: SnapshotOptions) => getSnapshot(options),
    getHistory: (options?: HistoryOptions) => getHistory(options),
    getInjectedHistory: () => getInjectedHistory(),
    getFloor: (floor: number) => getFloor(floor),
    getContextAtFloor: (options: { floor: number }) => getContextAtFloor(options),
    query: (request: PublicQueryRequest) => query(request),
    subscribe(listener: PublicChangeListener) {
      if (typeof listener !== 'function') throw new TypeError('subscribe listener 必须是函数');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

function numericArg(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new TypeError(`${label} 必须是整数`);
  return number;
}

function atArg(value: unknown): SnapshotAt | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const at = String(value).trim().toLowerCase();
  if (at !== 'before' && at !== 'after') throw new TypeError('at 只能是 before 或 after');
  return at;
}

function scalarText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function jsonText(value: unknown): string {
  if (value === undefined) return 'null';
  return JSON.stringify(value);
}

function textResult(value: PublicQueryResult): string {
  if (value && typeof value === 'object') {
    if ('historyBefore' in value && 'floorSummary' in value) {
      const context = value as PublicFloorContext;
      return [context.historyBefore.text, context.floorSummary].filter(Boolean).join('\n\n');
    }
    if ('mode' in value && value.mode === 'injection') {
      return (value as PublicInjectedHistory).relativeText;
    }
    if ('nodes' in value && 'text' in value) {
      return (value as PublicHistory | PublicInjectedHistory).text;
    }
    if ('memory' in value && 'body' in value) {
      const floor = value as PublicFloor;
      return floor.memory.summary || floor.body;
    }
  }
  return scalarText(value);
}

function formatResult(value: PublicQueryResult, format: string): string {
  if (format === 'raw') return scalarText(value);
  if (format === 'text') return textResult(value);
  return jsonText(value);
}

function firstUnnamed(value: unknown): string {
  if (Array.isArray(value)) return value.length ? String(value[0]) : '';
  return value === undefined || value === null ? '' : String(value);
}

function normalizeResource(value: unknown): PublicQueryRequest['resource'] {
  const raw = String(value ?? 'snapshot').trim();
  if (!raw) return 'snapshot';
  const normalized = raw.toLowerCase();
  if (normalized === 'itemlog' || normalized === 'item-log') return 'itemLog';
  if (normalized === 'injectedhistory' || normalized === 'injected-history') return 'injectedHistory';
  const resources: PublicQueryRequest['resource'][] = [
    'var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs',
    'snapshot', 'history', 'injectedHistory', 'floor', 'context',
  ];
  const matched = resources.find(resource => resource.toLowerCase() === normalized);
  if (!matched) throw new TypeError(`未知 resource: ${raw}`);
  return matched;
}

async function registerSlashCommand(): Promise<boolean> {
  try {
    const parserPath = '/scripts/slash-commands/SlashCommandParser.js';
    const commandPath = '/scripts/slash-commands/SlashCommand.js';
    const argumentPath = '/scripts/slash-commands/SlashCommandArgument.js';
    const [parserModule, commandModule, argumentModule] = await Promise.all([
      import(/* @vite-ignore */ parserPath),
      import(/* @vite-ignore */ commandPath),
      import(/* @vite-ignore */ argumentPath),
    ]);
    const { SlashCommandParser } = parserModule as {
      SlashCommandParser: { addCommandObject(command: unknown): void };
    };
    const { SlashCommand } = commandModule as {
      SlashCommand: { fromProps(props: Record<string, unknown>): unknown };
    };
    const { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } = argumentModule as {
      ARGUMENT_TYPE: Record<string, string>;
      SlashCommandArgument: { fromProps(props: Record<string, unknown>): unknown };
      SlashCommandNamedArgument: { fromProps(props: Record<string, unknown>): unknown };
    };

    const named = (props: Record<string, unknown>) => SlashCommandNamedArgument.fromProps(props);
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
      name: 'bbs-get',
      callback: (args: Record<string, unknown>, unnamed: unknown): string => {
        const namedResource = String(args.resource ?? '').trim();
        const resource = normalizeResource(namedResource || firstUnnamed(unnamed));
        const request: PublicQueryRequest = {
          resource,
          path: args.path === undefined ? undefined : String(args.path),
          floor: numericArg(args.floor, 'floor'),
          at: atArg(args.at),
          before: numericArg(args.before, 'before'),
        };
        const format = String(args.format ?? 'json').trim().toLowerCase();
        if (!['json', 'raw', 'text'].includes(format)) {
          throw new TypeError('format 只能是 json、raw 或 text');
        }
        return formatResult(query(request), format);
      },
      namedArgumentList: [
        named({
          name: 'resource',
          description: '要读取的资源',
          typeList: [ARGUMENT_TYPE.STRING],
          enumList: ['var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs', 'itemLog', 'snapshot', 'history', 'injectedHistory', 'floor', 'context'],
        }),
        named({
          name: 'path',
          description: '变量路径，例如 关系.爱丽丝.好感度 或 队伍[0].hp',
          typeList: [ARGUMENT_TYPE.STRING],
        }),
        named({
          name: 'floor',
          description: 'ST 零基 mesid',
          typeList: [ARGUMENT_TYPE.NUMBER],
        }),
        named({
          name: 'at',
          description: '快照位于目标楼之前或之后',
          typeList: [ARGUMENT_TYPE.STRING],
          defaultValue: 'after',
          enumList: ['before', 'after'],
        }),
        named({
          name: 'before',
          description: '历史剧情截止楼层，不包含该楼',
          typeList: [ARGUMENT_TYPE.NUMBER],
        }),
        named({
          name: 'format',
          description: '返回格式',
          typeList: [ARGUMENT_TYPE.STRING],
          defaultValue: 'json',
          enumList: ['json', 'raw', 'text'],
        }),
      ],
      unnamedArgumentList: [
        SlashCommandArgument.fromProps({
          description: '可选资源名，默认 snapshot',
          typeList: [ARGUMENT_TYPE.STRING],
          enumList: ['var', 'vars', 'state', 'protagonist', 'items', 'plans', 'scenes', 'npcs', 'itemLog', 'snapshot', 'history', 'injectedHistory', 'floor', 'context'],
        }),
      ],
      helpString: `
        <div>读取柏宝书的只读记忆数据，并把结果传入 STscript 管道。</div>
        <div><code>/bbs-get resource=var path="关系.爱丽丝.好感度" floor=42 at=after format=raw</code></div>
        <div><code>/bbs-get resource=context floor=42 format=json</code></div>
      `,
      returns: ARGUMENT_TYPE.STRING,
    }));
    return true;
  } catch (error) {
    console.warn('[柏宝书] /bbs-get 注册失败', error);
    return false;
  }
}

function macroSafe(read: () => unknown): string {
  try {
    return scalarText(read());
  } catch (error) {
    console.warn('[柏宝书] 公共宏读取失败', error);
    return '';
  }
}

function macroSnapshot(floor?: string, at?: string): PublicSnapshot {
  return getSnapshot({
    floor: numericArg(floor, 'floor'),
    at: atArg(at),
  });
}

async function registerMacros(): Promise<{ macros: boolean; parameterized: boolean }> {
  try {
    const powerUserPath = '/scripts/power-user.js';
    const powerUserModule = await import(/* @vite-ignore */ powerUserPath) as {
      power_user?: { experimental_macro_engine?: boolean };
    };
    if (powerUserModule.power_user?.experimental_macro_engine) {
      const macroSystemPath = '/scripts/macros/macro-system.js';
      const macroModule = await import(/* @vite-ignore */ macroSystemPath) as {
        macros: {
          register(name: string, options: Record<string, unknown>): unknown;
        };
        MacroCategory?: { CHAT?: string; VARIABLE?: string };
      };
      const categoryChat = macroModule.MacroCategory?.CHAT ?? 'chat';
      const categoryVariable = macroModule.MacroCategory?.VARIABLE ?? 'variable';
      const optionalFloor = {
        name: 'floor',
        optional: true,
        type: 'integer',
        sampleValue: '42',
        description: 'ST 零基 mesid；省略时为当前聊天末尾。',
      };
      const optionalAt = {
        name: 'at',
        optional: true,
        defaultValue: 'after',
        type: 'string',
        sampleValue: 'after',
        description: 'before 不含目标楼，after 包含目标楼。',
      };
      const definitions: Array<[string, Record<string, unknown>]> = [
        ['bbsVars', {
          category: categoryVariable,
          description: '返回柏宝书当前自定义变量 JSON。',
          handler: () => macroSafe(() => getSnapshot().vars),
        }],
        ['bbsState', {
          category: categoryChat,
          description: '返回柏宝书当前时间与地点状态 JSON。',
          handler: () => macroSafe(() => getSnapshot().state),
        }],
        ['bbsSnapshot', {
          category: categoryChat,
          unnamedArgs: [optionalFloor, optionalAt],
          description: '返回柏宝书当前或指定楼层的完整状态快照 JSON。',
          exampleUsage: ['{{bbsSnapshot}}', '{{bbsSnapshot::42::after}}'],
          handler: ({ unnamedArgs: [floor, at] }: { unnamedArgs: string[] }) =>
            macroSafe(() => macroSnapshot(floor, at)),
        }],
        ['bbsHistory', {
          category: categoryChat,
          unnamedArgs: [{
            name: 'before',
            optional: true,
            type: 'integer',
            sampleValue: '42',
            description: '仅返回 mesid 小于该值的历史剧情。',
          }],
          description: '返回柏宝书带相对时间的压缩历史剧情文本。',
          exampleUsage: ['{{bbsHistory}}', '{{bbsHistory::42}}'],
          handler: ({ unnamedArgs: [before] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getHistory({ before: numericArg(before, 'before') }).relativeText),
        }],
        ['bbsInjectedHistory', {
          category: categoryChat,
          description: '返回与正常记忆注入相同、已跳过滑动窗口的历史剧情文本。',
          exampleUsage: ['{{bbsInjectedHistory}}'],
          handler: () => macroSafe(() => getInjectedHistory().relativeText),
        }],
        ['bbsVar', {
          category: categoryVariable,
          unnamedArgs: [{
            name: 'path',
            type: 'string',
            sampleValue: '关系.爱丽丝.好感度',
            description: '点号和数组下标变量路径。',
          }, optionalFloor, optionalAt],
          description: '返回柏宝书指定路径的变量值。',
          exampleUsage: ['{{bbsVar::关系.爱丽丝.好感度}}', '{{bbsVar::队伍[0].hp::42::after}}'],
          handler: ({ unnamedArgs: [path, floor, at] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getVar(path, {
              floor: numericArg(floor, 'floor'),
              at: atArg(at),
            })),
        }],
        ['bbsFloor', {
          category: categoryChat,
          unnamedArgs: [{
            name: 'floor',
            type: 'integer',
            sampleValue: '42',
            description: 'ST 零基 mesid。',
          }],
          description: '返回指定楼层的正文与叶子摘要 JSON。',
          exampleUsage: ['{{bbsFloor::42}}'],
          handler: ({ unnamedArgs: [floor] }: { unnamedArgs: string[] }) =>
            macroSafe(() => getFloor(numericArg(floor, 'floor')!)),
        }],
      ];
      const results = definitions.map(([name, options]) => macroModule.macros.register(name, options));
      return {
        macros: results.every(Boolean),
        parameterized: results.every(Boolean),
      };
    }

    const legacyMacroPath = '/scripts/macros.js';
    const legacyModule = await import(/* @vite-ignore */ legacyMacroPath) as {
      MacrosParser: {
        registerMacro(name: string, value: () => string, description?: string): void;
      };
    };
    const stableMacros: Array<[string, () => string, string]> = [
      ['bbsVars', () => macroSafe(() => getSnapshot().vars), '返回柏宝书当前自定义变量 JSON。'],
      ['bbsState', () => macroSafe(() => getSnapshot().state), '返回柏宝书当前状态 JSON。'],
      ['bbsSnapshot', () => macroSafe(() => getSnapshot()), '返回柏宝书当前完整状态快照 JSON。'],
      ['bbsHistory', () => macroSafe(() => getHistory().relativeText), '返回柏宝书带相对时间的压缩历史剧情文本。'],
      ['bbsInjectedHistory', () => macroSafe(() => getInjectedHistory().relativeText), '返回与正常记忆注入相同、已跳过滑动窗口的历史剧情文本。'],
    ];
    for (const [name, handler, description] of stableMacros) {
      legacyModule.MacrosParser.registerMacro(name, handler, description);
    }
    return { macros: true, parameterized: false };
  } catch (error) {
    console.warn('[柏宝书] 公共宏注册失败', error);
    return { macros: false, parameterized: false };
  }
}

export async function registerPublicInterface(): Promise<void> {
  if (registered) return;
  registered = true;

  bumpPublicRevision();
  const api = createApi();
  (globalThis as typeof globalThis & { STBaiBaiBook?: STBaiBaiBookApi }).STBaiBaiBook = api;

  watch(
    [() => derivedMeta.rev, () => memory.summaries],
    queueChangedNotice,
    { deep: true },
  );
  bindPublicChangeEvents();

  const [slashAvailable, macroSupport] = await Promise.all([
    registerSlashCommand(),
    registerMacros(),
  ]);
  capabilities.slashCommand = slashAvailable;
  capabilities.macros = macroSupport.macros;
  capabilities.parameterizedMacros = macroSupport.parameterized;

  ready = true;
  emitNotice('ready');
  console.log('[柏宝书] 公共只读接口已就绪', clonePublic(capabilities));
}
