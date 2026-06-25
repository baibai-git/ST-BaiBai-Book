/**
 * 柏宝书记忆数据模型 —— 混合架构:叶子在消息上,压缩节点在森林
 *
 * 存储位置:
 *  - **叶子摘要**:存在 chat 消息对象的 extra.bbs_leaf 上(LeafExtra)。随消息/swipe
 *    由 ST 自动跟随(per-swipe extra)、随 chat 文件持久化。删消息→叶子随之消失;
 *    翻页→该 swipe 的叶子自动换上;regenerate/编辑→正文变 → srcHash 不匹配 → 叶子「陈旧」失效。
 *  - **压缩节点**(L1/L2…):存独立森林 chat_metadata.baibai_book.summaries(MemSummary,
 *    level≥1)。它是跨楼聚合、无单一消息可挂,用 childIds 引用下层(L1→叶子id、L2→L1id)。
 *
 * 核心:
 *  - state / items / plans 是**派生**:按楼层顺序扫 chat,重放每条有效叶子的 delta 算出,
 *    不持久化。删叶子/叶子陈旧 → 它的 delta 不再重放 → 派生自动回退。
 *  - 压缩节点只压**叙事文本**省注入 token,不带 delta、不影响结构化数据。
 *  - 编辑/删除一条已被压缩的叶子 → 删除包含它的整条祖先压缩链(见 apply.pruneBrokenComps)。
 */

export const MEMORY_KEY = 'baibai_book';
/** 3 = 混合架构(叶子在消息 extra);2 = 叶子也在森林;1 = 独立 items/plans/state */
export const MEMORY_VERSION = 3;

/**
 * 物品(派生产物,不持久化)。
 * id 是**确定性**的:`item:${规范化名}`,故重放每次得到同一 id,手动 op 可稳定引用。
 */
export interface MemItem {
  id: string;
  /** 物品名(同时作为匹配键) */
  name: string;
  /** 简述/备注 */
  desc?: string;
  /** 数量;省略表示不计数 */
  qty?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * 计划 / 悬念(派生产物,不持久化)。
 * id 确定性:`plan:${产生它的叶子id}#${在该叶子 add 数组里的序号}`。
 */
export interface MemPlan {
  id: string;
  /** plan=计划/目标,suspense=悬念/未解之谜 */
  kind: 'plan' | 'suspense';
  content: string;
  /** open=进行中,resolved=已了结 */
  status: 'open' | 'resolved';
  createdAt: number;
  resolvedAt?: number;
  /** 故事内「创建时间」(AI 直接输出的字符串,如 1988/9/29);与 createdAt(真实毫秒)无关 */
  createdTime?: string;
  /** 故事内「目标时间」(AI 直接输出,允许模糊值如「以后有机会」或留空) */
  targetTime?: string;
}

/**
 * 叶子摘要,存在 chat 消息对象的 extra.bbs_leaf 上(不进森林)。
 * 随 swipe_info 自动跟随、随 chat 文件持久化。**重放的唯一来源**。
 */
export interface LeafExtra {
  /** 稳定叶子 id(写入即固定),压缩节点 childIds 引用它 */
  id: string;
  /** 摘要正文 */
  text: string;
  /** 结构化增量 */
  delta: StoredDelta;
  /** 故事内起始时间(来自正文 <bbs_start> 标签;无标签时由 AI 补) */
  timeStart?: string;
  /** 故事内结束时间(来自正文 <bbs_end> 标签;无标签时由 AI 补) */
  timeEnd?: string;
  /** 旧字段:生成时的故事内时间快照(单值/合并串)。新数据用 timeStart/timeEnd;保留它做旧数据回退展示 */
  timeLabel?: string;
  /** 生成时刻(UI 展示与 tie-break;真实重放顺序以楼层物理顺序为准) */
  createdAt: number;
  /** hash(清洗后的 mes),正文变化时不匹配 → 叶子陈旧失效 */
  srcHash: string;
  /** 叶子结构版本 */
  v: 1;
}

/**
 * 压缩节点(森林节点,level ≥ 1)。扁平数组 + childIds 表达森林:
 * 不被任何节点 childIds 引用的节点即「根」。
 * childIds:L1 引用叶子 id(在消息 extra 上);L2+ 引用下层压缩节点 id(在本数组里)。
 */
export interface MemSummary {
  id: string;
  /** 摘要正文 */
  text: string;
  /** 压缩层级:1=L1,2=L2…(叶子 level 0 已迁到消息 extra) */
  level: number;
  createdAt: number;
  /** 是否自动生成(false=手动/迁移) */
  auto: boolean;
  /** 故事内起始时间(覆盖范围内第一条叶子的起始) */
  timeStart?: string;
  /** 故事内结束时间(覆盖范围内最后一条叶子的结束) */
  timeEnd?: string;
  /** 旧字段:生成时的当前时间快照。新数据用 timeStart/timeEnd;保留它做旧数据回退展示 */
  timeLabel?: string;
  /** 直接收纳的下层节点 id(L1→叶子id,L2+→下层压缩节点id) */
  childIds: string[];
}

/** 覆盖型当前状态 */
export interface MemState {
  /** 故事内当前时间 */
  time: string;
  /** 当前地点 */
  location: string;
}

/**
 * 顶层记忆对象。
 * **只有 version + summaries 是真源并持久化**;state / items / plans 是从 summaries
 * 重放算出的派生缓存(供页面响应式读取,saveMemory 不写它们)。
 */
export interface BaibaiMemory {
  version: number;
  /** 派生缓存:重放叶子 delta 得到 */
  state: MemState;
  /** 派生缓存 */
  items: MemItem[];
  /** 派生缓存 */
  plans: MemPlan[];
  /** 真源:叶子摘要森林 */
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

/** AI 摘要返回的完整 JSON(协议保持不变:AI 只产 add/update/remove/resolve) */
export interface SummaryDelta {
  /** 本楼层叙事摘要正文 */
  summary?: string;
  /** 覆盖型:故事内当前时间(直接写新值)。仅在正文无时间标签、需 AI 兜底时使用 */
  time?: string;
  /** 本段起始时间(仅正文缺 <bbs_start> 标签时让 AI 补) */
  timeStart?: string;
  /** 本段结束时间(仅正文缺 <bbs_end> 标签时让 AI 补) */
  timeEnd?: string;
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
    /** createdTime/targetTime 由 AI 直接输出(故事内时间字符串);targetTime 允许模糊或省略 */
    add?: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
    /** 按提示词里展示的短 id(p1/p2…)了结 */
    resolve?: string[];
  };
}

/**
 * 固化进叶子的结构化增量。与 SummaryDelta 几乎一致,但两点不同:
 *  1. plans.resolve 存的是**稳定 plan id**(而非运行期短序号 p1/p2);
 *  2. 扩展了仅供「手动操作」用的内部 op:plans.remove / plans.reopen、items 沿用 remove。
 * AI 永远不产这些内部 op;它们只在 UI 手动改动时写入。
 */
export interface StoredDelta {
  time?: string;
  location?: string;
  items?: {
    add?: ItemDelta[];
    update?: ItemDelta[];
    /** 按物品名移除(规范化匹配) */
    remove?: string[];
  };
  plans?: {
    add?: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
    /** 了结:稳定 plan id */
    resolve?: string[];
    /** 内部/手动:删除 plan(稳定 id) */
    remove?: string[];
    /** 内部/手动:重新开启已了结 plan(稳定 id) */
    reopen?: string[];
  };
}
