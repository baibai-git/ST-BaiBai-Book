import type {
  ItemLogEntry,
  JsonValue,
  MemItem,
  MemNpc,
  MemPlan,
  MemScene,
  MemState,
  StoredDelta,
} from '@/memory/types';

export type SnapshotAt = 'before' | 'after';

export interface SnapshotOptions {
  /** ST 零基 mesid。省略时查询当前聊天末尾。 */
  floor?: number;
  /** before 不含目标楼；after 含目标楼。默认 after。 */
  at?: SnapshotAt;
}

export interface HistoryOptions {
  /** 仅返回 mesid < before 的剧情。省略时查询全部历史。 */
  before?: number;
}

export interface PublicCapabilities {
  globalApi: true;
  slashCommand: boolean;
  macros: boolean;
  parameterizedMacros: boolean;
  events: true;
}

export interface PublicChatInfo {
  id: string | null;
  characterName: string | null;
  groupId: string | null;
  length: number;
}

export interface PublicCoverage {
  complete: boolean;
  missingAiFloors: number[];
}

export interface PublicSnapshot {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chat: PublicChatInfo;
  point: {
    floor: number | null;
    at: SnapshotAt;
    upToExclusive: number;
  };
  coverage: PublicCoverage;
  state: MemState;
  vars: Record<string, JsonValue>;
  items: MemItem[];
  plans: MemPlan[];
  scenes: MemScene[];
  npcs: MemNpc[];
  itemLog: ItemLogEntry[];
}

export interface PublicHistoryNode {
  id: string;
  kind: 'leaf' | 'comp';
  level: number;
  text: string;
  timeStart: string | null;
  timeEnd: string | null;
  timeLabel: string | null;
  createdAt: number;
  floorStart: number | null;
  floorEnd: number | null;
}

export interface PublicHistory {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chat: PublicChatInfo;
  before: number;
  coverage: PublicCoverage;
  text: string;
  relativeText: string;
  nodes: PublicHistoryNode[];
}

export interface PublicInjectedHistory {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chat: PublicChatInfo;
  mode: 'injection';
  coverage: PublicCoverage;
  text: string;
  relativeText: string;
  nodes: PublicHistoryNode[];
}

export interface PublicFloor {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chat: PublicChatInfo;
  floor: number;
  role: 'user' | 'assistant' | 'system';
  name: string;
  omitted: boolean;
  body: string;
  memory: {
    stored: boolean;
    valid: boolean;
    id: string | null;
    summary: string | null;
    delta: StoredDelta | null;
    timeStart: string | null;
    timeEnd: string | null;
    timeLabel: string | null;
    createdAt: number | null;
  };
}

export interface PublicFloorContext {
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chat: PublicChatInfo;
  floor: number;
  floorData: PublicFloor;
  floorSummary: string | null;
  floorDelta: StoredDelta | null;
  snapshotBefore: PublicSnapshot;
  snapshotAfter: PublicSnapshot;
  historyBefore: PublicHistory;
  coverage: PublicCoverage;
}

export type PublicQueryResource =
  | 'var'
  | 'vars'
  | 'state'
  | 'items'
  | 'plans'
  | 'scenes'
  | 'npcs'
  | 'itemLog'
  | 'snapshot'
  | 'history'
  | 'injectedHistory'
  | 'floor'
  | 'context';

export interface PublicQueryRequest {
  resource: PublicQueryResource;
  path?: string;
  floor?: number;
  at?: SnapshotAt;
  before?: number;
}

export type PublicQueryResult =
  | JsonValue
  | Record<string, JsonValue>
  | MemState
  | MemItem[]
  | MemPlan[]
  | MemScene[]
  | MemNpc[]
  | ItemLogEntry[]
  | PublicSnapshot
  | PublicHistory
  | PublicInjectedHistory
  | PublicFloor
  | PublicFloorContext
  | undefined;

export interface PublicChangeNotice {
  type: 'ready' | 'changed';
  apiVersion: 1;
  pluginVersion: string;
  revision: number;
  chatId: string | null;
  capabilities: PublicCapabilities;
}

export type PublicChangeListener = (notice: PublicChangeNotice) => void;

export interface STBaiBaiBookApi {
  readonly apiVersion: 1;
  readonly pluginVersion: string;
  readonly capabilities: PublicCapabilities;
  getVar(path: string, options?: SnapshotOptions): JsonValue | undefined;
  getSnapshot(options?: SnapshotOptions): PublicSnapshot;
  getHistory(options?: HistoryOptions): PublicHistory;
  getInjectedHistory(): PublicInjectedHistory;
  getFloor(floor: number): PublicFloor;
  getContextAtFloor(options: { floor: number }): PublicFloorContext;
  query(request: PublicQueryRequest): PublicQueryResult;
  subscribe(listener: PublicChangeListener): () => void;
}
