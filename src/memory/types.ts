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
  /** 是否随身(随角色移动);省略/true=随身,永远注入。false=存放某地,仅当前地点匹配才全量注入 */
  carried?: boolean;
  /** 非随身时的存放地点(故事内地名);carried=false 时用于与当前地点匹配 */
  location?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 物品变动日志条目(派生产物,不持久化)。
 * 重放叶子 delta 时顺带产出:每条 add/update/remove 记一条,带「故事内时间」。
 * 用途:注入主对话 + 喂摘要副API,让模型知道「这笔账已结算」,避免连续两段剧情把同一次消耗扣两次。
 */
export interface ItemLogEntry {
  /** 物品名 */
  name: string;
  /** add=获得/新增,update=数量或描述变更,remove=移除/消耗尽 */
  kind: 'add' | 'update' | 'remove';
  /** 变更前数量(仅在已知且有意义时);qty 不计数的物品省略 */
  from?: number;
  /** 变更后数量(remove 后为 0/省略) */
  to?: number;
  /** 故事内时间(取产生该变动的叶子 timeEnd,缺则 timeStart);无则空串 */
  time: string;
}

/**
 * 场景 / 地点(派生产物,不持久化)。
 * 纯地理层级:地点 ∈ 上级区域,用确定性 id 串成嵌套树(删/陈旧叶子→delta 不重放→树自动回退)。
 * id 确定性:`scene:${规范化路径,'/'分隔}`,故同一路径每次重放得同一 id、手动 op 可稳定引用。
 * 改某级名字 = 换 id(用 remove 旧 + add 新表达,见 apply.renameScene)。
 */
export interface MemScene {
  id: string;
  /** 本级地名(路径最后一段原文) */
  name: string;
  /** 完整路径原文(由粗到细,如 ["王都","城西区","归雁客栈"]),用于展示与匹配 */
  path: string[];
  /** 父节点 id;根节点为空串 */
  parentId: string;
  /** 地点描述(简短客观) */
  desc?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * NPC / 角色(派生产物,不持久化)。
 * 与物品(MemItem)同构:确定性 id `npc:${规范化名}`,重放幂等、手动 op 可稳定引用。
 * 省 token 机制类比物品的 carried/location:
 *  - follow=true 随行(同伴跟主角移动),永远在场全量注入;
 *  - follow≠true 定点,仅当 location 落在当前地点或其祖先链才全量注入,否则只发名+身份。
 * ⚠️ follow 默认 false(多数 NPC 定点),与物品 carried 默认随身相反。
 *
 * 字段分两层:
 *  - **档案层**(title/desc/personality):「他是谁/长什么样」,高门槛、几乎不变,记一次。
 *  - **即时层**(outfit/condition):「他现在怎么样」,覆盖型、换就盖、不沉淀历史,鼓励跟剧情刷新。
 *    即时层之所以不违反「只记长期重要信息」铁律,正因它压根不进历史——和当前时间/地点同性质。
 * important=true 的「主要角色」:永远全量注入(跳过在场判定),界面/注入弱化档案、突出即时状态面板。
 */
export interface MemNpc {
  id: string;
  /** 名字(同时作为匹配键) */
  name: string;
  /** 身份/职业一句话(不在场时唯一保留的信息) */
  title?: string;
  /** 固定外貌:发色/身材/疤痕等长期不变的体貌(档案层,高门槛,几乎不更新) */
  desc?: string;
  /** 简单性格 */
  personality?: string;
  /** 当前着装(即时层,覆盖型;换装/弄脏弄破即刷新,门槛远低于 desc) */
  outfit?: string;
  /** 当前状态/健康(即时层,覆盖型;受伤/疲惫/中毒等,无异常时空) */
  condition?: string;
  /** 是否「主要角色」:剧情核心主演,永远全量注入,只追踪即时状态、不追档案 */
  important?: boolean;
  /** 是否随行(随主角移动);省略/false=定点(按 location 匹配),true=同伴,永远在场 */
  follow?: boolean;
  /** 定点时的所在地(故事内地名);follow≠true 时用于与当前地点匹配 */
  location?: string;
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
  /**
   * 生成本叶子时所在的 swipe 页码(= 当时 message.swipe_id)。
   * 用于判定叶子归属:ST 生成新 swipe 时会 structuredClone 旧 extra(含 bbs_leaf),
   * 把上一页的叶子复制进新页;靠「叶子记录的页码 ≠ 当前 swipe_id」识别这种串页并失效。
   * 缺省(旧数据/迁移)按第一页(0)处理。
   */
  swipe?: number;
  /** 旧字段:hash(清洗后的 mes)。已废弃(叶子有效性改为楼层/结构匹配,不再比对正文);仅旧数据残留 */
  srcHash?: string;
  /**
   * 种子叶子标记:carryover(带数据建新对话)挂在 #0 的那条叶子,其 text 是旧对话「合并总结」的散文。
   * 它只服务于状态重放(deriveMemory 读 delta)与历史摘要注入(被 sum_carry_ 的 L2 收纳),
   * **不该进向量库**——否则召回会命中一整段总结(而旧对话的单条摘要已由 bundle 快照覆盖召回)。
   * collectLeaves 据此跳过它。
   */
  seed?: boolean;
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
  /** 当前地点(自由字符串,可任意细:如「杭州市滨江区某老小区-302室屋内」) */
  location: string;
  /**
   * 当前所在的「已记录场景节点」完整路径(由粗到细,如 ["杭州市","滨江区某老小区","302室屋内"])。
   * 由 AI 在改 location 时顺带给出,作权威定位连接 —— 解决 location 自由串与场景树的粒度错配。
   * 可比 location 粗(只指到上级);缺省/找不到时,定位退回按 location 的收紧模糊匹配。
   */
  locationPath?: string[];
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
  /** 派生缓存:走过的地点(地理嵌套树,从叶子 delta 重放) */
  scenes: MemScene[];
  /** 派生缓存:登场过的 NPC(从叶子 delta 重放) */
  npcs: MemNpc[];
  /** 派生缓存:近期物品变动日志(重放时产出,只留最近若干条) */
  itemLog: ItemLogEntry[];
  /** 真源:叶子摘要森林 */
  summaries: MemSummary[];
}

export function createEmptyMemory(): BaibaiMemory {
  return {
    version: MEMORY_VERSION,
    state: { time: '', location: '' },
    items: [],
    plans: [],
    scenes: [],
    npcs: [],
    itemLog: [],
    summaries: [],
  };
}

/* ============ AI 返回的增量 JSON 结构 ============ */

/** 物品指令里单个物品的形状 */
export interface ItemDelta {
  name: string;
  desc?: string;
  qty?: number;
  /** 是否随身(角色带在身上)。省略=随身;明确放在某地点的物品填 false */
  carried?: boolean;
  /** 非随身时的存放地点(故事内地名) */
  location?: string;
}

/** NPC 指令里单个角色的形状(AI / 手动共用) */
export interface NpcDelta {
  name: string;
  /** 身份/职业一句话 */
  title?: string;
  /** 固定外貌:长期不变的体貌(档案层) */
  desc?: string;
  /** 简单性格 */
  personality?: string;
  /** 当前着装(即时层,覆盖型) */
  outfit?: string;
  /** 当前状态/健康(即时层,覆盖型) */
  condition?: string;
  /** 是否「主要角色」(剧情核心主演,永远全量注入) */
  important?: boolean;
  /** 是否随行(随主角移动)。省略=定点;明确随主角同行的同伴填 true */
  follow?: boolean;
  /** 定点时的所在地(故事内地名) */
  location?: string;
}

/** 场景指令里单个地点的形状(AI / 手动共用) */
export interface SceneDelta {
  /** 完整地理路径,由粗到细(如 ["王都","城西区","归雁客栈"]) */
  path: string[];
  /** 地点描述(必填:写不出有意义描述的地点不记;重放时丢弃空描述节点) */
  desc?: string;
}

/**
 * 重设父级指令:把已存在的 node(及其整棵子树)平移到 newPath。
 * 覆盖三种情形(都是同一操作):给顶级加父、在已有父子间插入中间节点、改换父级。
 *  - node:该节点**当前**的完整路径(由粗到细)。
 *  - newPath:它应在的**新**完整路径(末段通常与 node 末段同名)。
 *  - descs:newPath 上新建/需补描述的层级,键=该级地名,值=描述(desc 必填原则的延伸)。
 */
export interface SceneReparent {
  node: string[];
  newPath: string[];
  descs?: Record<string, string>;
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
  /** 覆盖型:当前所在的已记录场景节点完整路径(由粗到细);与 location 同时给,作权威定位 */
  locationPath?: string[];
  /** 指令型:物品增删改 */
  items?: {
    add?: ItemDelta[];
    /** 按名字移除 */
    remove?: string[];
    /** 按名字更新数量/描述 */
    update?: ItemDelta[];
  };
  /** 指令型:场景/地点增改(逐级地理路径) */
  scenes?: {
    /** 新到达/新记录的地点;path 给完整地理路径,逐级 upsert */
    add?: SceneDelta[];
    /** 更新已有地点的描述 */
    update?: SceneDelta[];
    /** 重设父级:给已有节点加父 / 插入中间节点 / 换父(连子树平移) */
    reparent?: SceneReparent[];
  };
  /** 指令型:NPC 增删改 */
  npcs?: {
    /** 新登场/新记录的 NPC */
    add?: NpcDelta[];
    /** 按名字更新已有 NPC(身份/描述/性格/随行/所在地) */
    update?: NpcDelta[];
    /** 按名字移除(永久退场/死亡) */
    remove?: string[];
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
 *  2. 扩展了仅供「手动操作」用的内部 op:plans.remove / plans.reopen、items / scenes 沿用 remove。
 * AI 永远不产这些内部 op;它们只在 UI 手动改动时写入。
 */
export interface StoredDelta {
  time?: string;
  location?: string;
  /** 覆盖型:当前所在的已记录场景节点完整路径(由粗到细);权威定位 */
  locationPath?: string[];
  items?: {
    add?: ItemDelta[];
    update?: ItemDelta[];
    /** 按物品名移除(规范化匹配) */
    remove?: string[];
  };
  scenes?: {
    add?: SceneDelta[];
    update?: SceneDelta[];
    /** 重设父级(连子树平移);AI 与手动共用 */
    reparent?: SceneReparent[];
    /** 内部/手动:按完整路径移除(连带删其后代) */
    remove?: string[][];
  };
  npcs?: {
    add?: NpcDelta[];
    update?: NpcDelta[];
    /** 按 NPC 名移除(规范化匹配) */
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
