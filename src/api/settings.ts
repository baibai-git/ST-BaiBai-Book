import { getContext } from '@/st/context';
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
  /** 流式传输(默认关);开启后按 SSE 增量拼接 */
  stream: boolean;
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
  /** 保留最近 N 条 AI 消息发全文(滑动窗口);更早的自动摘要并隐藏 */
  keepRecent: number;
  /** 排除的角色名:这些名字(含重名卡)的聊天里,记忆系统所有功能都不生效 */
  excludedChars: string[];
  /** 叶子摘要积累到 N 条时,压成一条 L1 总结(L0→L1 阈值,0=关闭) */
  leafBatchThreshold: number;
  /** L1 及以上每积累到 N 条时,压成上一层总结(L≥1→L+1 阈值,0=关闭) */
  resummaryThreshold: number;
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
}

// extension_settings 里的命名空间键;localStorage 是旧版残留,仅用于一次性迁移。
const SETTINGS_KEY = 'baibai_book';
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
      embedding: { url: 'https://api.siliconflow.cn/v1', key: '', model: 'Qwen/Qwen3-Embedding-8B' },
      rerank: { url: '', key: '', model: 'Qwen/Qwen3-Reranker-4B' },
      queryRewrite: { url: '', key: '', model: 'Qwen/Qwen3.5-27B' },
      recall: {
        rerankCandidates: 20,
        embeddingThreshold: 0.8,
        rerankThreshold: 0.9,
        fullTextCount: 2,
        finalRecallCount: 5,
      },
    },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: true,
    keepRecent: 3,
    excludedChars: [],
    leafBatchThreshold: 12,
    resummaryThreshold: 7,
    summaryMaxRetries: 1,
    batchMaxChars: 30000,
    batchMaxFloors: 10,
    customStripTags: [],
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
  // vector 同为嵌套对象(且内含子对象),逐层兜底,老数据缺字段时回退默认。
  // 注:旧结构曾有 vector.channels + {channel,model};扁平化后弃用,逐角色按 url/key/model 兜底,
  // 老数据缺这些字段会回退空串(等于「未配置」,用户重填一次即可)。
  const rv = ((raw as Partial<ApiSettings>).vector ?? {}) as Partial<VectorSettings>;
  merged.vector = {
    ...d.vector,
    ...rv,
    embedding: normalizeVectorEndpoint(rv.embedding),
    rerank: normalizeVectorEndpoint(rv.rerank),
    queryRewrite: normalizeVectorEndpoint(rv.queryRewrite),
    recall: { ...d.vector.recall, ...(rv.recall ?? {}) },
  };
  // 副 API 渠道:逐个补全新加的字段(老数据没有 stream/excludeParams),并校验类型
  merged.channels = (Array.isArray(merged.channels) ? merged.channels : []).map(normalizeChannel);
  // 字数档位:仅两个合法值,旧数据缺失/非法回退详细(= 老用户行为不变)
  merged.verbosity = merged.verbosity === 'concise' ? 'concise' : 'detailed';
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
function normalizeVectorEndpoint(e: Partial<VectorEndpoint> | undefined): VectorEndpoint {
  const o = e ?? {};
  return {
    url: typeof o.url === 'string' ? o.url : '',
    key: typeof o.key === 'string' ? o.key : '',
    model: typeof o.model === 'string' ? o.model : '',
  };
}

/** 补全单个渠道的缺失字段(stream/excludeParams 是后加的),并校验类型。 */
function normalizeChannel(c: Partial<ApiChannel>): ApiChannel {
  return {
    id: typeof c.id === 'string' ? c.id : `ch_${Date.now()}_${++chanSeq}`,
    name: typeof c.name === 'string' ? c.name : '新渠道',
    url: typeof c.url === 'string' ? c.url : '',
    key: typeof c.key === 'string' ? c.key : '',
    model: typeof c.model === 'string' ? c.model : '',
    temperature: typeof c.temperature === 'number' ? c.temperature : 1.0,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : 8192,
    stream: typeof c.stream === 'boolean' ? c.stream : false,
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
  target.keepRecent = src.keepRecent;
  target.excludedChars = src.excludedChars;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.resummaryThreshold = src.resummaryThreshold;
  target.summaryMaxRetries = src.summaryMaxRetries;
  target.batchMaxChars = src.batchMaxChars;
  target.batchMaxFloors = src.batchMaxFloors;
  target.customStripTags = src.customStripTags;
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
    maxTokens: 8192,
    stream: false,
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
  };
}
