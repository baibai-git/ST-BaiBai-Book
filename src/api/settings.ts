import { getContext } from '@/st/context';
import { normalizeTemplate, type VarTemplate } from '@/memory/types';
import { reactive, watch } from 'vue';

/**
 * 副 API 设置(全局,跨聊天)。存进 ST 的 extension_settings(→ 服务器 settings.json),
 * 因而跨设备同步:手机/局域网另一端打开同一 ST 账户即可见到同一份设置。
 * (旧版本曾存浏览器 localStorage,只在本机生效;见 hydrateSettings 的一次性迁移。)
 * 渠道可配多个;两类摘要任务各指派一个渠道:summary=摘要,resummary=总结。
 */

export interface ApiChannel {
  id: string;
  /** 显示名 */
  name: string;
  /** OpenAI 兼容的 base url,如 https://api.openai.com/v1 */
  url: string;
  /** 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 采样温度 */
  temperature: number;
  /** 最大输出 token */
  maxTokens: number;
  /** 单次请求超时(秒)。超过后主动中断;每个渠道独立配置,默认 180 秒。 */
  timeoutSec: number;
  /** 流式传输(默认关);开启后按 SSE 增量拼接 */
  stream: boolean;
  /**
   * 发送预填充(默认开)。摘要/批量请求末尾带一条 assistant 预填充消息,引导模型从思维链续写、
   * 并压制拒答。Claude 等原生支持预填充的后端收益明显;若端点要求「最后一条必须是 user」
   * 或为纯 OpenAI 端点(预填充不被续写、形同浪费),可关掉——关掉只是不发那条尾 assistant,
   * 思维链引导仍由 system 检查清单承担,不影响功能。 */
  prefill: boolean;
  /** 排除参数:这些字段名会在构造请求体时从 body 中删除,
   *  用于规避不接受某些参数(如 temperature/max_tokens)的兼容端点报错。 */
  excludeParams: string[];
}

export type TaskType = 'summary' | 'resummary';

/** 自定义提示词:空串表示沿用 prompts.ts 内置模板,非空则整体覆盖该任务的模板。 */
export interface CustomPrompts {
  summary: string;
  /** 普通总结(L0 叶子 → L1):把多条楼层摘要压成一条 L1 总结。 */
  resummary: string;
  /** 二次总结(L1+ → 更上层):把多条总结再压一层,字数按输入规模动态放宽以少丢信息。 */
  resummary2: string;
  /** 破限提示词:附加在摘要/总结请求里;空串=不附加。 */
  jailbreak: string;
  /** 固定提示词(时间标签):注入**主对话**模型,要求每条正文前后输出时间标签;空=用内置默认。 */
  timeTag: string;
}

/**
 * 单个向量角色的端点配置(扁平:自带地址+密钥+模型,不再经「渠道」中转)。
 * embedding 为基准必填;rerank/queryRewrite 的 url 留空 = 整体复用 embedding 的端点与模型。
 */
export interface VectorEndpoint {
  /** OpenAI 兼容 base url(如 https://api.openai.com/v1);rerank/query 留空=复用 embedding */
  url: string;
  /** API 密钥 */
  key: string;
  /** 模型名 */
  model: string;
  /** 单次请求超时(秒)。超时即中断该次请求;各角色默认不同(见 defaults),不随地址复用回落。 */
  timeoutSec: number;
  /** 失败自动重试次数:仅超时/网络异常/服务端 5xx/限流 429 才重试;4xx 不重试。非负整数。 */
  retries: number;
}

/**
 * 召回参数。召回管线:
 *  ① 所有向量索引各算一次 embedding 相似度,**纯按得分排序取前 N(rerankCandidates)进入 rerank**——
 *     这一步不套 embedding 阈值,哪怕前 N 全是低分(0.4/0.3…)也照样进候选;阈值只在 ② 的摘要档准入用。
 *  ② rerank 打分后分两档:
 *     · 全文档 = rerank 得分 ≥ rerankThreshold,取前 fullTextCount 条(发原文全文);
 *     · 摘要档 = rerank 得分 < rerankThreshold 但 embedding 得分 ≥ embeddingThreshold(发叶子摘要);
 *  ③ 最终召回条数 ≤ finalRecallCount(上限):先放全文档,不足再用摘要档补,补不满也无妨。
 */
export interface VectorRecallSettings {
  /** 进入 rerank 的候选数:纯按 embedding 相似度取 top-N(不套阈值过滤) */
  rerankCandidates: number;
  /** embedding 相似度阈值:仅用于 ② 摘要档准入门槛(低于此连摘要都不召回);不影响 ① 取候选 */
  embeddingThreshold: number;
  /** rerank 得分阈值:≥ 进全文档,< 退摘要档 */
  rerankThreshold: number;
  /** 召回全文数:全文档取前 N 条(发原文) */
  fullTextCount: number;
  /** 最终召回条数(上限):全文档 + 摘要档合计不超过它 */
  finalRecallCount: number;
  /**
   * 召回起始 AI 楼数:当前聊天 AI 消息数少于此值时**不触发召回**(0=不限制)。
   * 用 AI 消息数计(与 keepRecent 同口径),避免和「楼层」混淆。
   * 早期剧情还没多少旧记忆可召,跳过可省额度/延迟;「带数据建新对话」的旧档不受此限(始终召回)。
   */
  minAiFloors: number;
}

/** 向量记忆设置。embedding 为基准,rerank/queryRewrite 的 url 留空则整体复用 embedding。 */
export interface VectorSettings {
  /** 向量记忆开关 */
  enabled: boolean;
  /** 文本向量化端点(基准,必填) */
  embedding: VectorEndpoint;
  /** 重排端点;url 留空复用 embedding */
  rerank: VectorEndpoint;
  /** 查询重写端点;url 留空复用 embedding */
  queryRewrite: VectorEndpoint;
  /** 查询重写请求是否置顶注入破限提示词(system;取自「自定义提示词 · 破限」,留空则用内置默认)。默认关。 */
  queryRewriteJailbreak: boolean;
  /** 查询重写单次最大输出 token(三角色里仅它生成文本;够放 INTENT + 多条 Q 即可,偏小会截断)。默认 8192。 */
  queryRewriteMaxTokens: number;
  /** 召回参数(候选数/阈值/条数) */
  recall: VectorRecallSettings;
}

/** 界面偏好里要跨设备同步的部分(主题/导航位置);activePage 等纯本机临时态不在此。 */
export interface UiPrefs {
  /** 主题名(合法值见 state/ui.ts 的 THEMES;这里只存字符串,避免 settings 反向依赖 ui) */
  theme: string;
  /** 导航位置:top/bottom/auto */
  navPosition: string;
  /** 移动端:再点当前页导航按钮即关闭整窗。默认开;怕误触的用户可关。 */
  navTapClose: boolean;
  /** 在 ST 顶栏注入一个快速打开按钮(魔杖菜单入口照旧保留)。默认关。 */
  showTopBar: boolean;
  /** 在聊天框上方注入「快速回复」式按钮,点击打开柏宝书。默认关。 */
  showQuickReply: boolean;
  /** 在每条 AI 楼层内注入摘要锚点(查看该楼摘要数据 + 标记番外)。默认关。 */
  showFloorPanel: boolean;
  /** 屏幕边缘悬浮球,点击打开柏宝书。默认关。 */
  showOrb: boolean;
  /** 悬浮球自定义图标:ST 服务器图片路径(saveBase64AsFile 返回的短串);空=用默认书签图标。跨设备同步。 */
  orbImage: string;
  /** 悬浮球形状:bookmark 书签(默认)/ circle 圆 / square 方。 */
  orbShape: string;
  /** 悬浮球静止时不透明度(百分比 20–100,默认 62)。唤起/拖动时一律全显。 */
  orbOpacity: number;
  /** 悬浮球基准尺寸(px,32–80,默认 48)。书签按比例放宽高,圆/方为等边边长。 */
  orbSize: number;
}

/** 字数详尽档位:detailed=详细(默认),concise=精简(摘要/总结/二次总结字数一并降低)。仅影响内置模板。 */
export type Verbosity = 'detailed' | 'concise';

export interface ApiSettings {
  /** 插件总开关。关闭后停止一切自动注入/摘要/总结/隐藏;ST 菜单入口仍在,可重新打开界面再开启。 */
  enabled: boolean;
  /** 界面偏好(主题/导航位置),随设置存进 extension_settings → 跨设备同步 */
  ui: UiPrefs;
  /** 自定义提示词模板(空=用内置) */
  prompts: CustomPrompts;
  /** 内置模板的字数详尽档位:详细/精简。自定义模板不受影响。 */
  verbosity: Verbosity;
  /** 向量记忆配置 */
  vector: VectorSettings;
  channels: ApiChannel[];
  /** 各任务指派的渠道 id */
  assignments: Record<TaskType, string>;
  /** 自动摘要开关。开启即一并启用:自动隐藏、正文时间标签、积压拦截(不再各自独立开关)。 */
  autoSummaryEnabled: boolean;
  /**
   * 仅摘要模式。继续分析、保存结构化状态,但不向主模型注入当前状态,
   * 也不再把物品/变量变动旁注写回正文。已有正文旁注不主动清理。
   */
  summaryOnlyMode: boolean;
  /** 保留最近 N 条 AI 消息发全文(滑动窗口);更早的自动摘要并隐藏 */
  keepRecent: number;
  /** 排除的角色名:这些名字(含重名卡)的聊天里,记忆系统所有功能都不生效 */
  excludedChars: string[];
  /** 摘要/总结时**整本排除**的世界书文件名:这些书的所有激活条目都不进摘要上下文。
   *  用于全局挂载的附加知识书等——它们对当前剧情摘要无用,排除可省 token。仅影响副API。 */
  excludedWorldNames: string[];
  /** 摘要/总结时按**条目名(comment)**过滤的规则:命中任一规则的条目不进摘要上下文。
   *  每条当正则编译(普通名字天然=包含匹配),编译失败降级为字面子串包含。仅影响副API。 */
  excludedWorldInfoPatterns: string[];
  /** 内置默认条目名规则是否已「播种」进上面的列表(见 DEFAULT_WI_PATTERNS / hydrateSettings)。
   *  只发放一次:老用户首次载入时补进默认规则并置 true;之后用户删空也不再补回,尊重其选择。 */
  wiPatternsSeeded: boolean;
  /** 渲染世界书模板(默认开):摘要副 API 取世界书条目前,先展开 {{宏}} 并执行 ST-Prompt-Template 的
   *  EJS(<% %>),让「按好感度切换人设」等动态条目拿到成品而非原文。副作用:含写变量的 EJS 每次摘要
   *  都会额外执行一次,污染变量状态——遇到这类世界书可关掉。未装 ST-Prompt-Template 时仅展开宏。 */
  renderWorldInfoTemplates: boolean;
  /** 叶子摘要积累到 N 条时,压成一条 L1 总结(L0→L1 阈值,0=关闭) */
  leafBatchThreshold: number;
  /**
   * 总结时**在叶子层保留最近 N 条摘要不压缩**(仅 L0→L1 生效,不影响更高层)。
   * 作用:压缩把一批叶子塌成一段 L1 后,注入端只走「根」——被收纳的叶子不再单独注入,
   * 细颗粒会一次性丢失(用户实测的「断崖」)。留一截最新叶子当根,注入端始终有细节兜底。
   * 机制:触发门槛抬到 `leafBatchThreshold + leafKeepRecent`,但每次仍只压最旧的
   * `leafBatchThreshold` 条(不改总结质量),newest 的 N 条自然留下。
   * 0=保持旧行为(攒够即全压);默认 3。设太大 = 迟迟不压、叶子堆积。 */
  leafKeepRecent: number;
  /** L1 及以上每积累到 N 条时,压成上一层总结(L≥1→L+1 阈值,0=关闭) */
  resummaryThreshold: number;
  /** 状态快照里附带「近期已完成计划/悬念」的条数:**计划、悬念各取最近 N 条**(0=不附带)。
   *  防 AI 把刚了结的计划当未完成又去推进/重新 add;注入与副API摘要两端同口径附带。 */
  recentResolvedPlansCount: number;
  /** 摘要/总结失败(请求报错或 JSON 解析失败)的最大重试次数。0=不重试;默认 1(最多再试一次)。 */
  summaryMaxRetries: number;
  /** 批量补摘:每批最大正文字符数(清洗后)。攒够即切块,控制单次请求规模(防 AI 注意力涣散)。 */
  batchMaxChars: number;
  /** 批量补摘:每批最大楼数兜底。即便字符没到上限,楼数到此也切块。 */
  batchMaxFloors: number;
  /**
   * 用户自定义「整块删除」标签名(只填标签名,不带尖括号,如 snow)。清洗正文时
   * `<snow>…</snow>` 连同内部内容一并删掉。用于剔除其它插件/世界书写进正文的状态栏、
   * 旁注等格式。改动对**召回时**即时生效(向量库存的是原文,召回再清洗),无需重建索引。
   */
  customStripTags: string[];
  /** 全局变量模板:所有角色所有聊天共享的初始 JSON 结构 + 说明(值仍每聊天独立)。见 memory 的 VarTier。 */
  varsGlobalTemplate: VarTemplate;
  /** 角色变量模板:键=角色卡 avatar 文件名,值=该角色所有聊天共享的初始模板(值仍每聊天独立)。 */
  varsTemplateByChar: Record<string, VarTemplate>;
}

// extension_settings 里的命名空间键;localStorage 是旧版残留,仅用于一次性迁移。
const SETTINGS_KEY = 'baibai_book';

/** 条目名过滤的内置默认规则:首次载入时「播种」进用户列表(见 hydrateSettings),之后用户可自由增删。
 *  \[mvu…\] = 过滤变量框架 MVU 的机制条目(对剧情摘要是纯噪音)。大小写不敏感(engine 编译带 i)。 */
const DEFAULT_WI_PATTERNS = ['\\[mvu[\\s\\S]*?\\]'];
const LEGACY_STORAGE_KEY = 'bbs.api.v1';
// 旧版界面偏好(主题/导航位置/分页)曾单独存这里;现把主题+导航迁进 ui,分页仍留本机(见 state/ui.ts)。
const LEGACY_UI_STORAGE_KEY = 'bbs.ui.v1';

/** 从旧 localStorage(bbs.ui.v1)取出主题/导航位置,填进 target.ui。仅在 server 尚无 ui 时调用一次。 */
function migrateLegacyUiPrefs(target: ApiSettings): void {
  try {
    const raw = localStorage.getItem(LEGACY_UI_STORAGE_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw) as Partial<UiPrefs>;
    if (typeof obj.theme === 'string') target.ui.theme = obj.theme;
    if (typeof obj.navPosition === 'string') target.ui.navPosition = obj.navPosition;
  } catch {
    /* 解析失败则维持默认,不阻断 */
  }
}

function defaults(): ApiSettings {
  return {
    enabled: true,
    ui: {
      theme: 'day',
      navPosition: 'auto',
      navTapClose: true,
      showTopBar: false,
      showQuickReply: false,
      showFloorPanel: false,
      showOrb: false,
      orbImage: '',
      orbShape: 'bookmark',
      orbOpacity: 62,
      orbSize: 48,
    },
    prompts: { summary: '', resummary: '', resummary2: '', jailbreak: '', timeTag: '' },
    verbosity: 'detailed',
    vector: {
      enabled: false,
      // 默认填硅基流动地址 + 各角色模型,用户只需在 embedding 填一次 key 即可跑通:
      // rerank/queryRewrite 的 url/key 留空会回落复用 embedding 的(见 resolveVectorModel)。
      embedding: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-Embedding-8B', timeoutSec: 10, retries: 1 },
      rerank: { url: '', key: '', model: 'Qwen/Qwen3-Reranker-4B', timeoutSec: 20, retries: 1 },
      queryRewrite: { url: '', key: '', model: 'Qwen/Qwen3.5-27B', timeoutSec: 90, retries: 1 },
      queryRewriteJailbreak: false,
      queryRewriteMaxTokens: 8192,
      recall: {
        rerankCandidates: 20,
        embeddingThreshold: 0.8,
        rerankThreshold: 0.9,
        fullTextCount: 2,
        finalRecallCount: 5,
        minAiFloors: 30,
      },
    },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: true,
    summaryOnlyMode: false,
    keepRecent: 3,
    excludedChars: [],
    excludedWorldNames: [],
    // 空起步:内置默认规则(DEFAULT_WI_PATTERNS)由 hydrateSettings「播种」发放,只发一次。
    // 这样老用户(已存过空数组)也能补到默认,且用户删空后不会被反复塞回。
    excludedWorldInfoPatterns: [],
    wiPatternsSeeded: false,
    renderWorldInfoTemplates: true,
    leafBatchThreshold: 12,
    leafKeepRecent: 3,
    resummaryThreshold: 7,
    recentResolvedPlansCount: 5,
    summaryMaxRetries: 1,
    batchMaxChars: 30000,
    batchMaxFloors: 10,
    customStripTags: [],
    varsGlobalTemplate: { json: {}, meaning: '', rule: '' },
    varsTemplateByChar: {},
  };
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalize(raw: unknown): ApiSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const merged = { ...d, ...(raw as Partial<ApiSettings>) };
  // prompts 是嵌套对象,展开合并不会补全缺字段,单独兜底(老数据没有 prompts 键时回退默认)
  merged.prompts = { ...d.prompts, ...((raw as Partial<ApiSettings>).prompts ?? {}) };
  // ui 同为嵌套对象,逐字段兜底(老数据没有 ui 键时回退默认,值非字符串时丢弃)
  const ru = ((raw as Partial<ApiSettings>).ui ?? {}) as Partial<UiPrefs>;
  merged.ui = {
    theme: typeof ru.theme === 'string' ? ru.theme : d.ui.theme,
    navPosition: typeof ru.navPosition === 'string' ? ru.navPosition : d.ui.navPosition,
    navTapClose: typeof ru.navTapClose === 'boolean' ? ru.navTapClose : d.ui.navTapClose,
    showTopBar: typeof ru.showTopBar === 'boolean' ? ru.showTopBar : d.ui.showTopBar,
    showQuickReply: typeof ru.showQuickReply === 'boolean' ? ru.showQuickReply : d.ui.showQuickReply,
    showFloorPanel: typeof ru.showFloorPanel === 'boolean' ? ru.showFloorPanel : d.ui.showFloorPanel,
    showOrb: typeof ru.showOrb === 'boolean' ? ru.showOrb : d.ui.showOrb,
    orbImage: typeof ru.orbImage === 'string' ? ru.orbImage : d.ui.orbImage,
    orbShape: typeof ru.orbShape === 'string' ? ru.orbShape : d.ui.orbShape,
    // 透明度:钳到 20–100,缺失/非法回退默认(太低会看不见,设 20 下限)
    orbOpacity:
      typeof ru.orbOpacity === 'number' && Number.isFinite(ru.orbOpacity)
        ? Math.min(100, Math.max(20, Math.round(ru.orbOpacity)))
        : d.ui.orbOpacity,
    // 尺寸:钳到 32–80,缺失/非法回退默认
    orbSize:
      typeof ru.orbSize === 'number' && Number.isFinite(ru.orbSize)
        ? Math.min(80, Math.max(32, Math.round(ru.orbSize)))
        : d.ui.orbSize,
  };
  // excludedChars 必须是字符串数组,旧值类型不符时回退空数组
  merged.excludedChars = Array.isArray(merged.excludedChars)
    ? merged.excludedChars.filter((x): x is string => typeof x === 'string')
    : [];
  // 排除世界书/条目名规则:字符串数组,去空,旧数据缺失/非法回退空数组
  merged.excludedWorldNames = Array.isArray(merged.excludedWorldNames)
    ? merged.excludedWorldNames.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  merged.excludedWorldInfoPatterns = Array.isArray(merged.excludedWorldInfoPatterns)
    ? merged.excludedWorldInfoPatterns.filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    : [];
  // 播种标记:布尔,缺失(老数据无此键)回退 false,让 hydrateSettings 首次补发默认规则
  merged.wiPatternsSeeded = typeof merged.wiPatternsSeeded === 'boolean' ? merged.wiPatternsSeeded : false;
  // 渲染世界书模板:布尔,缺失(老数据无此键)回退 true(默认开,让动态世界书条目拿到成品)
  merged.renderWorldInfoTemplates =
    typeof merged.renderWorldInfoTemplates === 'boolean' ? merged.renderWorldInfoTemplates : true;
  // vector 同为嵌套对象(且内含子对象),逐层兜底,老数据缺字段时回退默认。
  // 注:旧结构曾有 vector.channels + {channel,model};扁平化后弃用,逐角色按 url/key/model 兜底,
  // 老数据缺这些字段会回退空串(等于「未配置」,用户重填一次即可)。
  const rv = ((raw as Partial<ApiSettings>).vector ?? {}) as Partial<VectorSettings>;
  merged.vector = {
    ...d.vector,
    ...rv,
    embedding: normalizeVectorEndpoint(rv.embedding, d.vector.embedding),
    rerank: normalizeVectorEndpoint(rv.rerank, d.vector.rerank),
    queryRewrite: normalizeVectorEndpoint(rv.queryRewrite, d.vector.queryRewrite),
    recall: { ...d.vector.recall, ...(rv.recall ?? {}) },
  };
  // 召回起始 AI 楼数:非负整数,缺失/非法回退 0(不限制)
  merged.vector.recall.minAiFloors =
    Number.isFinite(merged.vector.recall.minAiFloors) && merged.vector.recall.minAiFloors >= 0
      ? Math.floor(merged.vector.recall.minAiFloors)
      : 0;
  // 查询重写破限开关:布尔,缺失(老数据无此键)回退 false(默认不注入)
  merged.vector.queryRewriteJailbreak =
    typeof merged.vector.queryRewriteJailbreak === 'boolean' ? merged.vector.queryRewriteJailbreak : false;
  // 查询重写最大输出 token:正整数,下限 256(太小会截断 INTENT/Q),缺失/非法回退默认 8192
  merged.vector.queryRewriteMaxTokens =
    Number.isFinite(merged.vector.queryRewriteMaxTokens) && merged.vector.queryRewriteMaxTokens >= 256
      ? Math.floor(merged.vector.queryRewriteMaxTokens)
      : 8192;
  // 副 API 渠道:逐个补全新加的字段(老数据没有 timeoutSec/stream/excludeParams),并校验类型
  merged.channels = (Array.isArray(merged.channels) ? merged.channels : []).map(normalizeChannel);
  // 字数档位:仅两个合法值,旧数据缺失/非法回退详细(= 老用户行为不变)
  merged.verbosity = merged.verbosity === 'concise' ? 'concise' : 'detailed';
  // 叶子层保留条数:非负整数,缺失/非法回退默认 3(0=旧行为攒够即全压)
  merged.leafKeepRecent =
    Number.isFinite(merged.leafKeepRecent) && merged.leafKeepRecent >= 0
      ? Math.floor(merged.leafKeepRecent)
      : 3;
  // 近期已完成计划条数:非负整数,缺失/非法回退默认 5(计划/悬念各取 N;0=不附带)
  merged.recentResolvedPlansCount =
    Number.isFinite(merged.recentResolvedPlansCount) && merged.recentResolvedPlansCount >= 0
      ? Math.floor(merged.recentResolvedPlansCount)
      : 5;
  // 重试次数:非负整数,旧数据缺失/非法回退默认 1
  merged.summaryMaxRetries =
    Number.isFinite(merged.summaryMaxRetries) && merged.summaryMaxRetries >= 0
      ? Math.floor(merged.summaryMaxRetries)
      : 1;
  // 批量补摘参数:正整数,缺失/非法回退默认值(下限 1,避免 0 导致永不切块/死循环)
  merged.batchMaxChars =
    Number.isFinite(merged.batchMaxChars) && merged.batchMaxChars >= 500
      ? Math.floor(merged.batchMaxChars)
      : 30000;
  merged.batchMaxFloors =
    Number.isFinite(merged.batchMaxFloors) && merged.batchMaxFloors >= 1
      ? Math.floor(merged.batchMaxFloors)
      : 10;
  // 自定义清洗标签:容错用户连尖括号/斜杠一起填进来(<snow> / </snow>),只留合法标签名字符;
  // 去空、去重,缺失/非数组回退空数组。
  merged.customStripTags = Array.isArray(merged.customStripTags)
    ? Array.from(
      new Set(
        merged.customStripTags
          .filter((x): x is string => typeof x === 'string')
          .map(sanitizeTagName)
          .filter(Boolean),
      ),
    )
    : [];
  // 变量模板:全局深规整;角色按 avatar 键逐份规整(丢弃空模板的键,保持存储干净)
  merged.varsGlobalTemplate = normalizeTemplate((raw as Partial<ApiSettings>).varsGlobalTemplate);
  const rawByChar = (raw as Partial<ApiSettings>).varsTemplateByChar;
  const byChar: Record<string, VarTemplate> = {};
  if (rawByChar && typeof rawByChar === 'object') {
    for (const [k, v] of Object.entries(rawByChar)) {
      const tpl = normalizeTemplate(v);
      if (Object.keys(tpl.json).length || tpl.meaning.trim() || tpl.rule.trim()) byChar[k] = tpl; // 非空才留
    }
  }
  merged.varsTemplateByChar = byChar;
  return merged;
}

/**
 * 把用户输入规整成可安全拼进正则的标签名。
 * 用黑名单(而非白名单)剔除会破坏标签语法/正则的危险字符:尖括号、斜杠、空白、正则元字符;
 * 中文及其它 unicode 字母一律保留(用户可能写 <雪><状态栏> 这类中文标签)。
 */
export function sanitizeTagName(raw: string): string {
  return String(raw ?? '')
    .trim()
    .replace(/^<\/?/, '') // 开头的 < 或 </
    .replace(/>$/, '') // 结尾的 >
    .trim()
    .replace(/[<>/\\\s.*+?^${}()|[\]]/g, ''); // 剔除尖括号/斜杠/空白/正则元字符,中文等保留
}

/** 补全单个向量端点的字段并校验类型(缺失/类型不符回退空串)。 */
function normalizeVectorEndpoint(
  e: Partial<VectorEndpoint> | undefined,
  def: Pick<VectorEndpoint, 'timeoutSec' | 'retries'>,
): VectorEndpoint {
  const o = e ?? {};
  return {
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
    model: typeof o.model === 'string' ? o.model : '',
    // 超时/重试老数据可能缺:各角色默认值不同(embedding 10s / rerank 20s / query 90s),
    // 必须按传入的角色默认回退,不能统一回退一个值。
    timeoutSec:
      typeof o.timeoutSec === 'number' && Number.isFinite(o.timeoutSec) && o.timeoutSec > 0
        ? o.timeoutSec
        : def.timeoutSec,
    retries:
      typeof o.retries === 'number' && Number.isFinite(o.retries) && o.retries >= 0
        ? Math.floor(o.retries)
        : def.retries,
  };
}

/** 补全单个渠道的缺失字段(timeoutSec/stream/excludeParams 是后加的),并校验类型。 */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 65535,
    timeoutSec:
      typeof c.timeoutSec === 'number' && Number.isFinite(c.timeoutSec) && c.timeoutSec > 0
        ? Math.floor(c.timeoutSec)
        : 180,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
    prefill: typeof c.prefill === 'boolean' ? c.prefill : true, // 后加字段:老数据默认开(保持原行为)
    excludeParams: Array.isArray(c.excludeParams)
      ? c.excludeParams.filter((x): x is string => typeof x === 'string')
      : [],
  };
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const apiSettings = reactive<ApiSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;

// hydrate 完成后要通知的订阅者(如 ui.ts:settings 就绪后才能拿到同步过来的主题/导航位置)。
// 若订阅时已就绪则立刻回调,避免错过时序。
const readyCbs: Array<() => void> = [];
export function onSettingsReady(cb: () => void): void {
  if (ready) cb();
  else readyCbs.push(cb);
}

function applyInto(target: ApiSettings, src: ApiSettings): void {
  target.enabled = src.enabled;
  target.ui = src.ui;
  target.prompts = src.prompts;
  target.verbosity = src.verbosity;
  target.vector = src.vector;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoSummaryEnabled = src.autoSummaryEnabled;
  target.summaryOnlyMode = src.summaryOnlyMode;
  target.keepRecent = src.keepRecent;
  target.excludedChars = src.excludedChars;
  target.excludedWorldNames = src.excludedWorldNames;
  target.excludedWorldInfoPatterns = src.excludedWorldInfoPatterns;
  target.wiPatternsSeeded = src.wiPatternsSeeded;
  target.renderWorldInfoTemplates = src.renderWorldInfoTemplates;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.leafKeepRecent = src.leafKeepRecent;
  target.resummaryThreshold = src.resummaryThreshold;
  target.recentResolvedPlansCount = src.recentResolvedPlansCount;
  target.summaryMaxRetries = src.summaryMaxRetries;
  target.batchMaxChars = src.batchMaxChars;
  target.batchMaxFloors = src.batchMaxFloors;
  target.customStripTags = src.customStripTags;
  target.varsGlobalTemplate = src.varsGlobalTemplate;
  target.varsTemplateByChar = src.varsTemplateByChar;
}

/** 写回 extension_settings 并防抖落盘到服务器(跨设备同步的关键)。 */
function persist(): void {
  const ctx = getContext();
  if (!ctx?.extensionSettings) return;
  ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
  ctx.saveSettingsDebounced?.();
}

/**
 * ST 就绪后调用:从 extension_settings 载入真实设置;
 * 若那里还没有、但 localStorage 有旧值,则迁移过去(老用户不丢配置),迁移后清掉旧键。
 * 完成后放行 watch 回写。可安全重复调用(只在首次真正 hydrate)。
 */
export function hydrateSettings(): void {
  if (ready) return;
  const ctx = getContext();
  if (!ctx?.extensionSettings) return; // ST 未就绪,稍后重试

  const stored = ctx.extensionSettings[SETTINGS_KEY];
  if (stored && typeof stored === 'object') {
    applyInto(apiSettings, normalize(stored));
    // 老用户:server 已有 api 设置但还没同步过界面偏好 → 把旧 localStorage 的主题/导航迁进来并落盘一次
    if (!('ui' in (stored as object))) {
      migrateLegacyUiPrefs(apiSettings);
      ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
      ctx.saveSettingsDebounced?.();
    }
    try {
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  } else {
    // 迁移:extension_settings 里没有 → 尝试搬运旧 localStorage
    let migrated: ApiSettings | null = null;
    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw) migrated = normalize(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    if (migrated) applyInto(apiSettings, migrated);
    // 界面偏好同样从旧 localStorage 迁入(新装用户没有此键则维持默认)
    migrateLegacyUiPrefs(apiSettings);
    // 把当前值(迁移来的或默认)写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
      localStorage.removeItem(LEGACY_UI_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  // 播种内置默认条目名规则:仅当从未发放过(老用户/新用户首次)才补进列表,并置标记 + 落盘。
  // 只发一次——用户之后删空也不会被反复塞回。追加而非覆盖,不动用户已有的自定义规则。
  if (!apiSettings.wiPatternsSeeded) {
    for (const pat of DEFAULT_WI_PATTERNS) {
      if (!apiSettings.excludedWorldInfoPatterns.includes(pat)) apiSettings.excludedWorldInfoPatterns.push(pat);
    }
    apiSettings.wiPatternsSeeded = true;
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
  }

  ready = true;
  for (const cb of readyCbs.splice(0)) {
    try {
      cb();
    } catch {
      /* 订阅者自身异常不阻断后续 */
    }
  }
}

watch(
  apiSettings,
  () => {
    if (!ready) return; // hydrate 前不回写,防止默认值覆盖服务器设置
    persist();
  },
  { deep: true },
);

let chanSeq = 0;
export function newChannel(): ApiChannel {
  chanSeq += 1;
  return {
    id: `ch_${Date.now()}_${chanSeq}`,
    name: '新渠道',
    url: '',
    key: '',
    model: '',
    temperature: 1.0,
    maxTokens: 65535,
    timeoutSec: 180,
    stream: false,
    prefill: true,
    excludeParams: [],
  };
}

/** 当前单角色聊天的角色名;群聊或未进入聊天时返回 null(群聊不参与排除)。 */
export function currentCharName(): string | null {
  const ctx = getContext();
  if (!ctx) return null;
  if (ctx.groupId) return null; // 群聊:多角色,不按单名排除
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)];
  return ch?.name ?? null;
}

/**
 * 当前角色的稳定键:avatar 文件名(唯一,重名卡也不冲突);取不到回退角色名。
 * 用于角色层变量定义的存储键(varsByChar[key])。群聊 / 未进入聊天返回 null(角色层此时不适用)。
 */
export function currentCharKey(): string | null {
  const ctx = getContext();
  if (!ctx || ctx.groupId) return null; // 群聊无单一角色
  const idx = ctx.characterId;
  if (idx === undefined || idx === null || idx === '') return null;
  const ch = ctx.characters?.[Number(idx)] as { avatar?: string; name?: string } | undefined;
  return ch?.avatar || ch?.name || null;
}

/**
 * 当前聊天是否被排除(该角色名在排除名单里)。被排除则记忆系统所有功能停用。
 * 按「名字」匹配:同名的重名卡会被一并排除——符合用户「这批重名卡一起排除」的诉求。
 */
export function isCurrentChatExcluded(): boolean {
  if (!apiSettings.excludedChars.length) return false;
  const name = currentCharName();
  return name !== null && apiSettings.excludedChars.includes(name);
}

/** 引擎是否在当前聊天生效:总开关开着且当前角色未被排除。各功能闸门统一走它。 */
export function engineActiveHere(): boolean {
  return apiSettings.enabled && !isCurrentChatExcluded();
}

export function getChannelForTask(task: TaskType): ApiChannel | null {
  const id = apiSettings.assignments[task];
  if (!id) return null;
  return apiSettings.channels.find(c => c.id === id) ?? null;
}

/**
 * 解析某个向量角色实际使用的端点(url/key/model)。
 * 三个角色的**模型各自独立**(embedding/rerank/query 模型本就不同),从不复用;
 * 能复用的只有**地址与密钥**:rerank/queryRewrite 的 url/key 各自留空时,分别回落到 embedding 的。
 */
export function resolveVectorModel(role: 'embedding' | 'rerank' | 'queryRewrite'): VectorEndpoint {
  const v = apiSettings.vector;
  const base = v.embedding;
  if (role === 'embedding') return { ...base };
  const cfg = v[role];
  return {
    url: cfg.url.trim() || base.url, // 地址留空 → 复用 embedding 地址
    key: cfg.key.trim() || base.key, // 密钥留空 → 复用 embedding 密钥
    model: cfg.model, // 模型始终独立,不回落
    timeoutSec: cfg.timeoutSec, // 超时/重试始终独立,不回落(各角色默认本就不同)
    retries: cfg.retries,
  };
}
