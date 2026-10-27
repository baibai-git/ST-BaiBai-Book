/**
 * 柏宝书记忆数据模型 —— 混合架构:叶子在消息上,压缩节点在森林
 *
 * 存储位置:
 *  - **叶子摘要**:存在 chat 消息对象的 extra.bbs_leaf 上(LeafExtra)。随消息/swipe
 *    由 ST 自动跟随(per-swipe extra)、随 chat 文件持久化。删消息→叶子随之消失;
 *    翻页/regenerate→按 swipe 页码切换有效叶子;普通正文编辑不再自动废除摘要。
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

/* ============ 自定义变量(MVU 式:一个 JSON 对象 + 路径命令) ============ */

/** JSON 值。自定义变量的「状态」就是一棵这样的树,AI 用路径命令自由增删改。 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/**
 * 变量的作用域层级。**只影响「初始模板存哪」,值永远每聊天独立**(从各聊天自己的叶子 varOps 重放):
 *  - global:所有角色所有聊天共享模板(存 extension_settings)。
 *  - char:当前角色的所有聊天共享模板(存 extension_settings,按角色 avatar 区分)。
 *  - chat:仅当前聊天(存 chatMetadata,默认档)。
 * 载入时三层模板深合并(chat > char > global)成初始状态;命令(delta)只存叶子(chat),故值天然每聊天独立。
 */
export type VarTier = 'global' | 'char' | 'chat';

/**
 * 一层的变量「定义」= 初始结构模板 + 给 AI 的说明(拆两段)。三层各一份,载入时深合并成初始状态。
 *  - json:初始 JSON(根须是对象),用户预先搭好想追踪的结构(可留空对象,让 AI 从零建)。
 *  - meaning:各字段**是什么**(含义/取值范围)。主API(写正文)与副API(摘要)都会拿到——
 *    主API据此理解当前值,只读参考。
 *  - rule:**何时怎么改**、可否新建对象(相当于 MVU 的变化条件/命令约定)。**只发副API**——
 *    它含「如何增删改」的指令,主API看到会误以为要在正文里输出/复述变量,故对主API屏蔽。
 */
export interface VarTemplate {
  json: Record<string, JsonValue>;
  meaning: string;
  rule: string;
}

/**
 * 路径命令(AI 与手动共用;固化进叶子 delta.varOps,按楼层重放)。仿 MVU 的 set/assign/remove/add:
 *  - set:把 path 处的值设为 value(自动创建中间层)。path='' 表示整棵根。
 *  - assign:往 path 处的对象/数组插入。给 key 则 obj[key]=value(数组则该下标);不给 key 则数组 push value。
 *  - remove:删除。给 key 删对象键 / 数组下标 / 数组里等于 key 的元素;不给 key 删 path 本身。
 *  - add:把 path 处的数字加上 delta(负数即减)。
 */
export interface VarOp {
  op: 'set' | 'assign' | 'remove' | 'add';
  /** 点/括号寻址,如 "势力.魔法议会.声望" 或 "队伍[0].hp";'' = 根 */
  path: string;
  /** assign/remove 用:对象键或数组下标(或数组里要删的值) */
  key?: string | number;
  /** set/assign 用:要写入的值 */
  value?: JsonValue;
  /** add 用:数字增量 */
  delta?: number;
}

/** 把任意来源规整成一份变量模板(json 须对象;json 允许传字符串,尝试解析)。纯函数,供 settings/store 共用。 */
export function normalizeTemplate(raw: unknown): VarTemplate {
  let json: Record<string, JsonValue> = {};
  let meaning = '';
  let rule = '';
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (o.json && typeof o.json === 'object' && !Array.isArray(o.json)) {
      json = o.json as Record<string, JsonValue>;
    } else if (typeof o.json === 'string') {
      try {
        const p = JSON.parse(o.json);
        if (p && typeof p === 'object' && !Array.isArray(p)) json = p;
      } catch { /* 非法 JSON → 空对象 */ }
    }
    if (typeof o.meaning === 'string') meaning = o.meaning;
    if (typeof o.rule === 'string') rule = o.rule;
    // 兼容:外部分享的旧格式只有单一 guide 时,并入 rule(含义可留空,不影响使用)。
    if (!meaning && !rule && typeof o.guide === 'string') rule = o.guide;
  }
  return { json, meaning, rule };
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

/** 五档定性标记,不是可累加的分数。 */
export type NpcAffinityLevel = -2 | -1 | 0 | 1 | 2;

/** 对主角的内心好感与外在态度估计。省略=保持;null=明确恢复未知,与中性(0)不同。 */
export interface NpcAffinity {
  /** 真实好恶/亲近倾向,不是爱情、信任或服从度。 */
  affinityInner?: NpcAffinityLevel | null;
  /** 相对稳定的对外态度,不是本轮语气或心情。 */
  affinityOuter?: NpcAffinityLevel | null;
  /** 一句依据/表现/矛盾说明;同档默认沿用,空字符串=明确清空。 */
  affinityNote?: string;
}

/**
 * NPC 相对主角当前场景的在场地分档(判定逻辑见 apply.classifyNpcPresence 单一权威)。
 * 摘要名册的在场标记、主对话注入分档、NPC 页分组共用同一套词汇。
 */
export type NpcPresence = 'present' | 'nearby' | 'absent';

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
export interface MemNpc extends NpcAffinity {
  id: string;
  /** 名字(同时作为匹配键) */
  name: string;
  /** 性别(档案层;短值,如「男」「女」。不受在场判定影响,所有分档都注入,防 AI 搞错性别) */
  gender?: string;
  /**
   * 年龄原文(记录时的值,如「25」「二十出头」)。**不随时间自动改写存储**:
   * 配套 ageTime 锚点,注入/展示时由 ageDisplay 按当前故事时间推算(时间跳跃自动长岁),
   * AI 忘不忘更新都不影响正确性。正文再次明确年龄(过生日/纠正)时覆盖,锚点随之刷新。
   */
  age?: string;
  /** 年龄锚点:记录 age 时的故事内时间。AI 不填——重放时系统自动盖上该叶子的 timeEnd */
  ageTime?: string;
  /** 与主角的关系(覆盖型;引导格式「称谓[,持续立场]」,立场可无,称谓在开头供不在场档截取) */
  relation?: string;
  /** 与其他角色的重要关系(档案层,高门槛;如「阿黛尔之父;与镇长有旧怨」) */
  ties?: string;
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
  /** 定点时的所在地(故事内地名);follow≠true 时用于与当前地点匹配。空=所在不明(离场且去向未明) */
  location?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 用户操控的主角当前档案(派生产物,不持久化)。
 * 只记录剧情中明确出现、会影响后续续写的客观事实;不从行为推断性格或内心。
 * 地点与物品已有独立状态,不在这里重复。
 */
export interface MemProtagonist {
  /** 性别/性别表现(正文明确时记录) */
  gender?: string;
  /** 年龄原文(与 NPC 同机制:配 ageTime 锚点,展示/注入时按当前故事时间推算) */
  age?: string;
  /** 年龄锚点:记录 age 时的故事内时间,重放时系统自动盖 */
  ageTime?: string;
  /** 当前身份、职业、种族或公开地位 */
  identity?: string;
  /** 当前稳定外貌/身体特征;永久变身、伤疤等变化后覆盖 */
  appearance?: string;
  /** 当前着装(覆盖型) */
  outfit?: string;
  /** 当前身体状态/健康(覆盖型;恢复正常后清空) */
  condition?: string;
}

/**
 * 计划/悬念的「了结方式」。区分三种截然不同的收场,避免统一「已完成」误导主模型:
 *  - done      = 计划真去做成/兑现了、悬念真揭晓了(结果已明确);
 *  - cancelled = 没做成而是被取消/撤回/放弃/作废/不再需要(如对方收回要求、当场被化解退让);
 *  - failed    = 尝试过但失败,或悬念以坏结局收场。
 */
export type PlanOutcome = 'done' | 'cancelled' | 'failed';

/**
 * 一条「了结」指令。id:在 SummaryDelta 里是运行期短序号(p1/p2);在 StoredDelta 里是稳定 plan id。
 * outcome/reason 携带「怎么了结、为什么」,注入时展示给主模型,消除「已完成却还反复提」的困惑。
 */
export interface PlanResolveEntry {
  id: string;
  outcome?: PlanOutcome;
  /** 一句话了结原因(为什么下架 / 如何收场) */
  reason?: string;
}
/** 兼容:历史数据/降级时元素可能是裸字符串(= 无 outcome/原因),故 resolve 元素两态皆可。 */
export type PlanResolveItem = string | PlanResolveEntry;

/**
 * 计划改期/暂缓:同一未了结事项的新安排。
 * id 在 SummaryDelta 里是短序号(p1/p2),在 StoredDelta 里已翻译为稳定 plan id。
 * 只整体更新 content / targetTime;不可与同一编号的 resolve 同时出现。
 */
export interface PlanUpdateItem {
  id: string;
  content?: string;
  /** 新期限;空字符串=撤销旧期限且新期未定(清除 targetTime) */
  targetTime?: string;
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
  /** 了结方式(仅 status=resolved 时有);区分「真做了(done)」与「取消/作废(cancelled)」「失败(failed)」 */
  outcome?: PlanOutcome;
  /** 一句话了结原因(为什么下架/如何收场);注入给主模型,防「已完成却还提」 */
  resolvedReason?: string;
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
  /** 直接收纳的下层节点 id(L1→叶子id,L2+→下层压缩节点id);导入历史作为原子节点时为空。 */
  childIds: string[];
  /** 从插件外部导入的原子历史节点。它没有逐楼叶子,由下面的楼层范围直接代表旧剧情。 */
  imported?: boolean;
  /** 导入历史覆盖的起始楼层(当前第一版固定为 0,保留字段供以后扩展分段导入)。 */
  importedFloorStart?: number;
  /** 导入历史覆盖的截止楼层(含)。范围内楼层不再重复补摘。 */
  importedFloorEnd?: number;
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
  /** 互动局势卡:当前场面快照。null=无;覆盖语义(整卡替换,不是补丁) */
  sceneFocus: SceneFocus | null;
}

/**
 * 互动局势卡:「眼下正在发生什么」的一张小快照,服务陪伴卡与剧情卡双口径。
 * 三种 delta 语义:省略字段=不更新;null=明确清空;对象=整卡覆盖。
 * updatedTime 由代码在重放时盖故事内时间,不由 AI 输出。
 */
export interface SceneFocus {
  /** 当前局面一句话(陪伴卡写互动氛围,剧情卡写处境) */
  situation: string;
  /** 当前在场参与者 */
  participants: string[];
  /** @deprecated 已废弃(与 situation 重叠,不再提示 AI 输出);仅为兼容旧数据保留,有值时仍注入/展示 */
  currentFocus?: string;
  /** 互动张力(高门槛,仅明确且持续的社交张力;可选) */
  tension?: string;
  /** 即将发生之事(仅正文明确预告/约定/已启动等待结果;禁预测;可选) */
  pendingBeat?: string;
  /** 本快照对应的故事内时间(代码盖章) */
  updatedTime?: string;
}

/**
 * 生活小档案一条:主角或主要角色的偏好/习惯/近期个人状态。
 * 铁律:归属明确,只记本人明说过/正文明确揭示的,禁止从单次行为推断。
 * 三投放层(注入选择,不动真源):pinned 置顶常驻(≤5) / active 时效内相关才注入 / archive 沉降仅关键词触发。
 */
export interface MemLifeDetail {
  /** 稳定 id:detail:${leafId}#${add序号}(重放幂等、手动 op 可稳定引用) */
  id: string;
  /** 所属人物:user 为主角,其他值为 NPC 名册中的名字;旧数据省略视为 user。 */
  subject?: string;
  /** 细节正文一句话(主语由 subject 单独表示) */
  text: string;
  /** 主题标签(1-3 个,触发匹配用,如「饮食」「作息」) */
  topics: string[];
  /** 关键词锚点(原文可检索词,如「香菜」「项目」) */
  anchors: string[];
  /** 投放层:pinned 手动置顶 / active 默认 / archive 已沉降 */
  tier: 'pinned' | 'active' | 'archive';
  /** 时效:故事内到期时间(空=长期稳定) */
  until?: string;
  /** 记录时的故事内时间 */
  createdTime?: string;
  createdAt: number;
}

/** AI 侧新增生活细节(tier 由代码定为 active,置顶仅手动) */
export interface LifeDetailAdd {
  /** user 为主角,其他值为角色名;旧格式省略仍按主角处理。 */
  subject?: string;
  text: string;
  topics?: string[];
  anchors?: string[];
  until?: string;
}

/** AI 侧更新生活细节(id 可为短序号 d1/d2,finalize 时翻成稳定 id) */
export interface LifeDetailUpdate {
  id: string;
  /** 省略保持归属;明确纠正人物时才填,user 表示改回主角。 */
  subject?: string;
  text?: string;
  topics?: string[];
  anchors?: string[];
  until?: string;
}

/**
 * 了解清单一条:某角色目前知道/以为的一件主角的事(防人设全知:没记的私事默认不知道)。
 * 记的是角色的认知而非真相,把握程度写进句子(认定…/怀疑…/听说…/主角自称…),被骗就照记被骗后的认知。
 */
export interface MemKnowledge {
  /** 稳定 id:know:${leafId}#${操作序号}(重放幂等、手动 op 可稳定引用) */
  id: string;
  /** 知情的角色名(NPC 名册中的名字;只记角色→主角) */
  subject: string;
  text: string;
  /** 记录时的故事内时间 */
  createdTime?: string;
  createdAt: number;
}

/**
 * 了解清单的存储操作:有序日志,按数组顺序重放。
 * 不学生活小档案的 add→update→remove 分桶——手动「删了再加回」按分桶顺序会被吞掉。
 */
export type KnowledgeOp =
  | { op: 'add'; subject: string; text: string }
  | { op: 'update'; id: string; subject?: string; text?: string }
  | { op: 'remove'; id: string };

/**
 * 顶层记忆对象。
 * **只有 version + summaries 是真源并持久化**;state / items / plans 是从 summaries
 * 重放算出的派生缓存(供页面响应式读取,saveMemory 不写它们)。
 */
export interface BaibaiMemory {
  version: number;
  /** 派生缓存:重放叶子 delta 得到 */
  state: MemState;
  /** 派生缓存:用户操控主角的当前客观档案 */
  protagonist: MemProtagonist;
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
  /** 派生缓存:主角及角色生活小档案(从叶子 delta 重放) */
  lifeDetails: MemLifeDetail[];
  /** 派生缓存:各角色对主角的了解清单(从叶子 delta 重放) */
  knowledge: MemKnowledge[];
  /** 真源镜像:三层变量定义模板(global/char 来自 settings,chat 来自 chatMetadata) */
  varTemplates: Record<VarTier, VarTemplate>;
  /** 派生缓存:变量当前状态(从合并模板起、fold 各叶子 varOps 得到的 JSON 树) */
  vars: Record<string, JsonValue>;
  /** 真源:叶子摘要森林 */
  summaries: MemSummary[];
}

export function createEmptyMemory(): BaibaiMemory {
  return {
    version: MEMORY_VERSION,
    state: { time: '', location: '', sceneFocus: null },
    protagonist: {},
    items: [],
    plans: [],
    lifeDetails: [],
    knowledge: [],
    scenes: [],
    npcs: [],
    itemLog: [],
    varTemplates: { global: { json: {}, meaning: '', rule: '' }, char: { json: {}, meaning: '', rule: '' }, chat: { json: {}, meaning: '', rule: '' } },
    vars: {},
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
export interface NpcDelta extends NpcAffinity {
  name: string;
  /** 性别(档案层,短值;所有分档都注入) */
  gender?: string;
  /** 年龄原文(首次明确/被纠正时才写;锚点 ageTime 由重放自动盖,AI 不填) */
  age?: string;
  /** 年龄锚点(仅手动 op / carryover 种子会带;AI 输出里没有这个字段) */
  ageTime?: string;
  /** 与主角的关系(覆盖型;称谓在开头) */
  relation?: string;
  /** 与其他角色的重要关系(档案层,高门槛) */
  ties?: string;
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
  /** 旧存档的伤情局部补丁(v0.17 编号协议,已停用):仅重放,新输出不再产生 */
  conditionPatch?: ConditionPatch;
  /** 是否「主要角色」(剧情核心主演,永远全量注入) */
  important?: boolean;
  /** 是否随行(随主角移动)。省略=定点;明确随主角同行的同伴填 true */
  follow?: boolean;
  /**
   * 定点时的所在地(故事内地名)。空字符串=所在不明:角色已离开当前场景但去向未写明,
   * 清掉旧地点、不再视为在场;之后说明去向时再填新地点。
   */
  location?: string;
}

/**
 * 主角当前档案的覆盖补丁。
 * 字段省略=保持不变;空字符串=明确清空旧值(如伤势痊愈、脱下旧着装)。
 */
export interface ProtagonistDelta {
  gender?: string;
  /** 年龄原文(首次明确/纠正时才写;ageTime 锚点由重放自动盖) */
  age?: string;
  /** 年龄锚点(仅手动 op / carryover 会带) */
  ageTime?: string;
  identity?: string;
  appearance?: string;
  outfit?: string;
  /** 当前状态/健康(覆盖型) */
  condition?: string;
  /** 旧存档的伤情局部补丁(v0.17 编号协议,已停用):仅重放,新输出不再产生 */
  conditionPatch?: ConditionPatch;
}

/**
 * 旧版伤情局部补丁的片段操作(仅重放旧存档)。
 * - replace 用 id(c1/c2…)定位旧片段,text 为空串表示清除该片段;
 * - add 追加新片段,不带 id;
 * 未列入 replace 的旧片段由程序原样保留。编号只在单次请求内有效。
 */
export interface ConditionPatchOp {
  id?: string;
  text: string;
  /** 本轮正文连续原文短引(仅校验,不存档) */
  evidence?: string;
}

export interface ConditionPatch {
  replace?: ConditionPatchOp[];
  add?: ConditionPatchOp[];
}

/** 场景指令里单个地点的形状(AI / 手动共用) */
export interface SceneDelta {
  /** 完整地理路径,由粗到细(如 ["王都","城西区","归雁客栈"]) */
  path: string[];
  /** 地点描述(add 可省:建点宽、描述严;update 给空串=清除描述,节点保留) */
  desc?: string;
}

/**
 * 重设父级指令:把已存在的 node(及其整棵子树)平移到 newPath。
 * 覆盖三种情形(都是同一操作):给顶级加父、在已有父子间插入中间节点、改换父级。
 *  - node:该节点**当前**的完整路径(由粗到细)。
 *  - newPath:它应在的**新**完整路径(末段通常与 node 末段同名)。
 *  - descs:newPath 上新建/需补描述的层级,键=该级地名,值=描述(可省,写不出不编)。
 */
export interface SceneReparent {
  node: string[];
  newPath: string[];
  descs?: Record<string, string>;
}

/**
 * 手动场景操作的有序日志。
 *
 * AI 摘要仍使用 scenes.add/update/reparent 的分桶协议；UI 后续编辑则写进 ops，
 * 避免多次操作合并到同一叶子后被固定的 add→update→reparent→remove 顺序打乱。
 */
export type SceneOp =
  | { op: 'add'; path: string[]; desc?: string }
  | { op: 'update'; path: string[]; desc?: string }
  | { op: 'reparent'; node: string[]; newPath: string[]; descs?: Record<string, string> }
  | { op: 'remove'; path: string[] };

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
  /** 局势卡更新:省略=不动;null=明确清空;对象=整卡覆盖 */
  sceneFocus?: SceneFocus | null;
  /** 覆盖型:用户操控主角的当前客观档案变化 */
  protagonist?: ProtagonistDelta;
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
    /** 按提示词里展示的短 id(p1/p2…)了结,每项带 outcome/reason 说明怎么了结;裸字符串兼容旧格式 */
    resolve?: PlanResolveItem[];
    /** 同一未了结事项改期/暂缓/改条件(短 id p1/p2…);同一编号每楼只做一次 update 或 resolve */
    update?: PlanUpdateItem[];
  };
  /** 指令型:生活小档案增删改(可选;只记主角或主要角色归属明确、明说过/明文揭示的) */
  lifeDetails?: {
    add?: LifeDetailAdd[];
    update?: LifeDetailUpdate[];
    /** 沉降为仅关键词触发(短序号 d1/d2 或稳定 id) */
    archive?: string[];
    /** 删除(短序号 d1/d2 或稳定 id) */
    remove?: string[];
  };
  /** 指令型:了解清单增删改(可选;只记角色亲耳听到/亲眼看到/听人说的主角的事) */
  knowledge?: {
    add?: { who: string; text: string }[];
    /** 短序号 k1/k2 或稳定 id */
    update?: { id: string; text: string }[];
    /** 短序号 k1/k2 或稳定 id */
    remove?: string[];
  };
  /**
   * 指令型:自定义变量的路径命令数组(仿 MVU)。AI 看当前 JSON 状态 + 说明,产出本楼新事件对应的命令:
   *  - { "op":"set", "path":"好感度", "value":60 }
   *  - { "op":"add", "path":"好感度", "delta":5 }
   *  - { "op":"assign", "path":"势力", "key":"魔法议会", "value":{ "立场":"中立", "声望":50 } }  // 新建对象
   *  - { "op":"remove", "path":"势力", "key":"暗影会" }
   */
  vars?: VarOp[];
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
  /** 局势卡更新:省略=不动;null=明确清空;对象=整卡覆盖 */
  sceneFocus?: SceneFocus | null;
  /** 覆盖型:用户操控主角的当前客观档案变化 */
  protagonist?: ProtagonistDelta;
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
    /** 内部/手动:严格按用户操作先后重放；旧的分桶字段继续兼容历史聊天。 */
    ops?: SceneOp[];
  };
  npcs?: {
    add?: NpcDelta[];
    update?: NpcDelta[];
    /** 按 NPC 名移除(规范化匹配) */
    remove?: string[];
  };
  plans?: {
    add?: { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }[];
    /** 了结:稳定 plan id(带 outcome/reason);裸字符串兼容旧数据 */
    resolve?: PlanResolveItem[];
    /** 改期/暂缓:稳定 plan id + 新 content/targetTime */
    update?: PlanUpdateItem[];
    /** 内部/手动:删除 plan(稳定 id) */
    remove?: string[];
    /** 内部/手动:重新开启已了结 plan(稳定 id) */
    reopen?: string[];
  };
  /** 自定义变量:本楼的路径命令序列(按顺序 fold 到 JSON 状态)。AI 与手动共用。 */
  lifeDetails?: {
    add?: LifeDetailAdd[];
    /** update 带 tier:手动置顶/恢复操作用(AI 不出 tier) */
    update?: (LifeDetailUpdate & { tier?: 'pinned' | 'active' | 'archive' })[];
    /** 沉降为仅关键词触发(稳定 id) */
    archive?: string[];
    /** 删除(稳定 id) */
    remove?: string[];
  };
  /** 了解清单:按顺序施加的操作日志(AI 与手动共用) */
  knowledge?: KnowledgeOp[];
  varOps?: VarOp[];
}
