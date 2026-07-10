import { deriveMemory, getLeaf, leafValid } from '@/memory/apply';
import { isRealAiReply, pendingAiFloors } from '@/memory/engine';
import {
  renderHistoryNodes,
  renderHistoryNodesWithRelative,
  selectHistoryNodesBefore,
  selectInjectionNodes,
} from '@/memory/inject';
import type { ViewNode } from '@/memory/select';
import { memory } from '@/memory/store';
import { cleanBody, latestStoryTime } from '@/memory/timeTag';
import type { JsonValue, MemSummary } from '@/memory/types';
import { getContext } from '@/st/context';
import { PLUGIN_VERSION } from '@/version';
import type {
  HistoryOptions,
  PublicChatInfo,
  PublicCoverage,
  PublicFloor,
  PublicFloorContext,
  PublicHistory,
  PublicHistoryNode,
  PublicInjectedHistory,
  PublicQueryRequest,
  PublicQueryResult,
  PublicSnapshot,
  SnapshotAt,
  SnapshotOptions,
} from './types';

export const PUBLIC_API_VERSION = 1 as const;

let publicRevision = 0;

export function getPublicRevision(): number {
  return publicRevision;
}

export function bumpPublicRevision(): number {
  publicRevision += 1;
  return publicRevision;
}

export function clonePublic<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

function activeChat(): {
  chat: NonNullable<ReturnType<typeof getContext>>['chat'];
  info: PublicChatInfo;
} {
  const ctx = getContext();
  const id = ctx?.getCurrentChatId?.() ?? null;
  const chat = id && Array.isArray(ctx?.chat) ? ctx.chat : [];
  return {
    chat,
    info: {
      id,
      characterName: ctx?.name2?.trim() || null,
      groupId: ctx?.groupId?.trim() || null,
      length: chat.length,
    },
  };
}

function requireInteger(value: number, label: string): number {
  if (!Number.isInteger(value)) throw new TypeError(`${label} 必须是整数`);
  return value;
}

function requireFloor(floor: number, chatLength: number): number {
  const value = requireInteger(floor, 'floor');
  if (value < 0 || value >= chatLength) {
    throw new RangeError(`floor 超出范围: ${value}，当前聊天有效范围为 0-${Math.max(0, chatLength - 1)}`);
  }
  return value;
}

function resolveAt(at: SnapshotAt | undefined): SnapshotAt {
  if (at === undefined) return 'after';
  if (at !== 'before' && at !== 'after') throw new TypeError(`at 只能是 "before" 或 "after"`);
  return at;
}

function resolveBefore(before: number | undefined, chatLength: number): number {
  if (before === undefined) return chatLength;
  const value = requireInteger(before, 'before');
  if (value < 0 || value > chatLength) {
    throw new RangeError(`before 超出范围: ${value}，当前聊天有效范围为 0-${chatLength}`);
  }
  return value;
}

function coverageAt(chat: ReturnType<typeof activeChat>['chat'], upToExclusive: number): PublicCoverage {
  const missingAiFloors = pendingAiFloors(chat).filter(floor => floor < upToExclusive);
  return {
    complete: missingAiFloors.length === 0,
    missingAiFloors,
  };
}

function snapshotPoint(
  options: SnapshotOptions | undefined,
  chatLength: number,
): { floor: number | null; at: SnapshotAt; upToExclusive: number } {
  const at = resolveAt(options?.at);
  if (options?.floor === undefined) {
    return {
      floor: chatLength > 0 ? chatLength - 1 : null,
      at: 'after',
      upToExclusive: chatLength,
    };
  }
  const floor = requireFloor(options.floor, chatLength);
  return {
    floor,
    at,
    upToExclusive: at === 'before' ? floor : floor + 1,
  };
}

export function getSnapshot(options?: SnapshotOptions): PublicSnapshot {
  const { chat, info } = activeChat();
  const point = snapshotPoint(options, chat.length);
  const derived = deriveMemory(chat, point.upToExclusive);
  return clonePublic({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chat: info,
    point,
    coverage: coverageAt(chat, point.upToExclusive),
    state: derived.state,
    vars: derived.vars,
    items: derived.items,
    plans: derived.plans,
    scenes: derived.scenes,
    npcs: derived.npcs,
    itemLog: derived.itemLog,
  });
}

function buildHistoryNodeMap(
  summaries: MemSummary[],
  chat: ReturnType<typeof activeChat>['chat'],
): Map<string, ViewNode> {
  const byId = new Map<string, ViewNode>();
  for (let i = 0; i < chat.length; i++) {
    const message = chat[i];
    if (message?.extra?.bbs_omit || !leafValid(message)) continue;
    const leaf = getLeaf(message)!;
    byId.set(leaf.id, {
      id: leaf.id,
      kind: 'leaf',
      level: 0,
      text: leaf.text,
      timeStart: leaf.timeStart,
      timeEnd: leaf.timeEnd,
      timeLabel: leaf.timeLabel,
      createdAt: leaf.createdAt,
      childIds: [],
      msgIndex: i,
      active: message.is_system === true,
    });
  }
  for (const summary of summaries) {
    byId.set(summary.id, {
      id: summary.id,
      kind: 'comp',
      level: summary.level,
      text: summary.text,
      timeStart: summary.timeStart,
      timeEnd: summary.timeEnd,
      timeLabel: summary.timeLabel,
      createdAt: summary.createdAt,
      childIds: summary.childIds ?? [],
      msgIndex: -1,
      active: false,
    });
  }
  return byId;
}

function nodeFloorRange(node: ViewNode, byId: Map<string, ViewNode>): [number | null, number | null] {
  const floors: number[] = [];
  const seen = new Set<string>();
  const visit = (current: ViewNode): void => {
    if (seen.has(current.id)) return;
    seen.add(current.id);
    if (current.kind === 'leaf') {
      floors.push(current.msgIndex);
      return;
    }
    for (const childId of current.childIds) {
      const child = byId.get(childId);
      if (child) visit(child);
    }
  };
  visit(node);
  return floors.length ? [Math.min(...floors), Math.max(...floors)] : [null, null];
}

function historyNodeDto(node: ViewNode, byId: Map<string, ViewNode>): PublicHistoryNode {
  const [floorStart, floorEnd] = nodeFloorRange(node, byId);
  return {
    id: node.id,
    kind: node.kind,
    level: node.level,
    text: node.text,
    timeStart: node.timeStart?.trim() || null,
    timeEnd: node.timeEnd?.trim() || null,
    timeLabel: node.timeLabel?.trim() || null,
    createdAt: node.createdAt,
    floorStart,
    floorEnd,
  };
}

export function getHistory(options?: HistoryOptions): PublicHistory {
  const { chat, info } = activeChat();
  const before = resolveBefore(options?.before, chat.length);
  const selected = selectHistoryNodesBefore(memory.summaries, chat, before);
  const byId = buildHistoryNodeMap(memory.summaries, chat);
  return clonePublic({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chat: info,
    before,
    coverage: coverageAt(chat, before),
    text: renderHistoryNodes(selected),
    relativeText: renderHistoryNodesWithRelative(selected, latestStoryTime(chat.slice(0, before))),
    nodes: selected.map(node => historyNodeDto(node, byId)),
  });
}

export function getInjectedHistory(): PublicInjectedHistory {
  const { chat, info } = activeChat();
  const selected = selectInjectionNodes(memory.summaries, chat);
  const byId = buildHistoryNodeMap(memory.summaries, chat);
  const missingAiFloors = pendingAiFloors(chat).filter(floor => chat[floor]?.is_system === true);
  return clonePublic({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chat: info,
    mode: 'injection',
    coverage: {
      complete: missingAiFloors.length === 0,
      missingAiFloors,
    },
    text: renderHistoryNodes(selected),
    relativeText: renderHistoryNodesWithRelative(selected, latestStoryTime(chat)),
    nodes: selected.map(node => historyNodeDto(node, byId)),
  });
}

function floorRole(message: ReturnType<typeof activeChat>['chat'][number]): PublicFloor['role'] {
  if (message.is_user) return 'user';
  return isRealAiReply(message) ? 'assistant' : 'system';
}

export function getFloor(floor: number): PublicFloor {
  const { chat, info } = activeChat();
  const index = requireFloor(floor, chat.length);
  const message = chat[index];
  const leaf = getLeaf(message);
  const valid = !message.extra?.bbs_omit && leafValid(message);
  return clonePublic({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chat: info,
    floor: index,
    role: floorRole(message),
    name: typeof message.name === 'string' ? message.name : '',
    omitted: message.extra?.bbs_omit === true,
    body: cleanBody(typeof message.mes === 'string' ? message.mes : ''),
    memory: {
      stored: !!leaf,
      valid,
      id: valid ? leaf!.id : null,
      summary: valid ? leaf!.text : null,
      delta: valid ? leaf!.delta : null,
      timeStart: valid ? leaf!.timeStart?.trim() || null : null,
      timeEnd: valid ? leaf!.timeEnd?.trim() || null : null,
      timeLabel: valid ? leaf!.timeLabel?.trim() || null : null,
      createdAt: valid && typeof leaf!.createdAt === 'number' ? leaf!.createdAt : null,
    },
  });
}

export function getContextAtFloor(options: { floor: number }): PublicFloorContext {
  const { chat, info } = activeChat();
  const floor = requireFloor(options.floor, chat.length);
  const floorData = getFloor(floor);
  const snapshotBefore = getSnapshot({ floor, at: 'before' });
  const snapshotAfter = getSnapshot({ floor, at: 'after' });
  const historyBefore = getHistory({ before: floor });
  return clonePublic({
    apiVersion: PUBLIC_API_VERSION,
    pluginVersion: PLUGIN_VERSION,
    revision: getPublicRevision(),
    chat: info,
    floor,
    floorData,
    floorSummary: floorData.memory.summary,
    floorDelta: floorData.memory.delta,
    snapshotBefore,
    snapshotAfter,
    historyBefore,
    coverage: snapshotAfter.coverage,
  });
}

function parsePath(path: string): Array<string | number> {
  const segments: Array<string | number> = [];
  for (const part of String(path ?? '').split('.')) {
    if (part === '') continue;
    const match = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!match) {
      segments.push(part);
      continue;
    }
    if (match[1]) segments.push(match[1]);
    for (const index of match[2].match(/\d+/g) ?? []) segments.push(Number(index));
  }
  return segments;
}

function readPath(root: Record<string, JsonValue>, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = root;
  for (const segment of parsePath(path)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = Array.isArray(current)
      ? current[Number(segment)]
      : current[String(segment)];
  }
  return current;
}

export function getVar(path: string, options?: SnapshotOptions): JsonValue | undefined {
  return clonePublic(readPath(getSnapshot(options).vars, path));
}

function requiredQueryFloor(request: PublicQueryRequest): number {
  if (request.floor === undefined) throw new TypeError(`${request.resource} 查询必须提供 floor`);
  return request.floor;
}

export function query(request: PublicQueryRequest): PublicQueryResult {
  if (!request || typeof request !== 'object') throw new TypeError('query request 必须是对象');
  const snapshotOptions = { floor: request.floor, at: request.at };
  switch (request.resource) {
    case 'var':
      if (typeof request.path !== 'string') throw new TypeError('var 查询必须提供 path');
      return getVar(request.path, snapshotOptions);
    case 'vars':
      return getSnapshot(snapshotOptions).vars;
    case 'state':
      return getSnapshot(snapshotOptions).state;
    case 'items':
      return getSnapshot(snapshotOptions).items;
    case 'plans':
      return getSnapshot(snapshotOptions).plans;
    case 'scenes':
      return getSnapshot(snapshotOptions).scenes;
    case 'npcs':
      return getSnapshot(snapshotOptions).npcs;
    case 'itemLog':
      return getSnapshot(snapshotOptions).itemLog;
    case 'snapshot':
      return getSnapshot(snapshotOptions);
    case 'history':
      return getHistory({ before: request.before ?? request.floor });
    case 'injectedHistory':
      return getInjectedHistory();
    case 'floor':
      return getFloor(requiredQueryFloor(request));
    case 'context':
      return getContextAtFloor({ floor: requiredQueryFloor(request) });
    default:
      throw new TypeError(`未知 resource: ${String((request as { resource?: unknown }).resource)}`);
  }
}
