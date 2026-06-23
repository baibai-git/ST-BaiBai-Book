/**
 * 柏宝书记忆数据模型
 *
 * 存储位置:chat_metadata.baibai_book(与单个聊天绑定)。
 * 两类字段语义:
 *  - 覆盖型(state.*):当前状态,每次摘要直接写最新值。
 *  - 指令型(items / plans):持续累积的集合,摘要给出 add/remove/resolve 指令,
 *    由代码增量施加,而非每轮重抄全量。
 */

export const MEMORY_KEY = 'baibai_book';
export const MEMORY_VERSION = 1;

/** 物品 */
export interface MemItem {
  id: string;
  /** 物品名(同时作为 AI 指令里的匹配键) */
  name: string;
  /** 简述/备注 */
  desc?: string;
  /** 数量;省略表示不计数 */
  qty?: number;
  createdAt: number;
  updatedAt: number;
  /** 产生它的摘要 id(用于删除摘要时连带清除该楼层衍生数据) */
  sourceId?: string;
}

/** 计划 / 悬念 */
export interface MemPlan {
  id: string;
  /** plan=计划/目标,suspense=悬念/未解之谜 */
  kind: 'plan' | 'suspense';
  content: string;
  /** open=进行中,resolved=已了结 */
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  /** 产生它的摘要 id(用于删除摘要时连带清除该楼层衍生数据) */
  sourceId?: string;
}

/** 一条摘要 */
export interface MemSummary {
  id: string;
  /** 摘要正文 */
  text: string;
  /** 此摘要覆盖(压缩)的消息索引集合 */
  coveredIndices: number[];
  /** 层级:1=楼层摘要,2+=二次总结 */
  depth: number;
  createdAt: number;
  /** 是否自动生成(false=手动) */
  auto: boolean;
  /** 二次总结时,被合并的下层摘要 id */
  mergedFrom?: string[];
  /** 生成时的当前时间/地点快照(便于展示时间线) */
  timeLabel?: string;
}

/** 覆盖型当前状态 */
export interface MemState {
  /** 故事内当前时间 */
  time: string;
  /** 当前地点 */
  location: string;
}

/** 顶层记忆对象 */
export interface BaibaiMemory {
  version: number;
  state: MemState;
  items: MemItem[];
  plans: MemPlan[];
  summaries: MemSummary[];
}

export function createEmptyMemory(): BaibaiMemory {
  return {
    version: MEMORY_VERSION,
    state: { time: '', location: '' },
    items: [],
    plans: [],
    summaries: [],
  };
}

/* ============ AI 返回的增量 JSON 结构 ============ */

/** 物品指令里单个物品的形状 */
export interface ItemDelta {
  name: string;
  desc?: string;
  qty?: number;
}

/** AI 摘要返回的完整 JSON */
export interface SummaryDelta {
  /** 本楼层叙事摘要正文 */
  summary?: string;
  /** 覆盖型:故事内当前时间(直接写新值) */
  time?: string;
  /** 覆盖型:当前地点(直接写新值) */
  location?: string;
  /** 指令型:物品增删改 */
  items?: {
    add?: ItemDelta[];
    /** 按名字移除 */
    remove?: string[];
    /** 按名字更新数量/描述 */
    update?: ItemDelta[];
  };
  /** 指令型:计划/悬念增删 */
  plans?: {
    add?: { kind: 'plan' | 'suspense'; content: string }[];
    /** 按提示词里展示的短 id(p1/p2…)了结 */
    resolve?: string[];
  };
}
