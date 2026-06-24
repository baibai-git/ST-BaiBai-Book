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
}

export type TaskType = 'summary' | 'resummary';

/** 自定义提示词:空串表示沿用 prompts.ts 内置模板,非空则整体覆盖该任务的模板。 */
export interface CustomPrompts {
  summary: string;
  resummary: string;
  /** 破限提示词:附加在摘要/总结请求里;空串=不附加。 */
  jailbreak: string;
}

export interface ApiSettings {
  /** 插件总开关。关闭后停止一切自动注入/摘要/总结/隐藏;ST 菜单入口仍在,可重新打开界面再开启。 */
  enabled: boolean;
  /** 自定义提示词模板(空=用内置) */
  prompts: CustomPrompts;
  channels: ApiChannel[];
  /** 各任务指派的渠道 id */
  assignments: Record<TaskType, string>;
  /** 自动摘要开关 */
  autoSummaryEnabled: boolean;
  /** 保留最近 N 条 AI 消息发全文(滑动窗口);更早的自动摘要并隐藏 */
  keepRecent: number;
  /** 自动隐藏被摘要覆盖的消息 */
  autoHide: boolean;
  /** 叶子摘要积累到 N 条时,压成一条 L1 总结(L0→L1 阈值,0=关闭) */
  leafBatchThreshold: number;
  /** L1 及以上每积累到 N 条时,压成上一层总结(L≥1→L+1 阈值,0=关闭) */
  resummaryThreshold: number;
}

// extension_settings 里的命名空间键;localStorage 是旧版残留,仅用于一次性迁移。
const SETTINGS_KEY = 'baibai_book';
const LEGACY_STORAGE_KEY = 'bbs.api.v1';

function defaults(): ApiSettings {
  return {
    enabled: true,
    prompts: { summary: '', resummary: '', jailbreak: '' },
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: false,
    keepRecent: 5,
    autoHide: true,
    leafBatchThreshold: 12,
    resummaryThreshold: 7,
  };
}

/** 把任意来源的原始对象并入默认值,容错缺字段/类型不符。 */
function normalize(raw: unknown): ApiSettings {
  if (!raw || typeof raw !== 'object') return defaults();
  const d = defaults();
  const merged = { ...d, ...(raw as Partial<ApiSettings>) };
  // prompts 是嵌套对象,展开合并不会补全缺字段,单独兜底(老数据没有 prompts 键时回退默认)
  merged.prompts = { ...d.prompts, ...((raw as Partial<ApiSettings>).prompts ?? {}) };
  return merged;
}

// import 阶段 ST 往往尚未就绪,先以默认值建 reactive;真实值由 hydrateSettings 灌入。
export const apiSettings = reactive<ApiSettings>(defaults());

// 守门标志:hydrate 完成前不回写,避免「默认值」覆盖服务器上已存的设置。
let ready = false;

function applyInto(target: ApiSettings, src: ApiSettings): void {
  target.enabled = src.enabled;
  target.prompts = src.prompts;
  target.channels = src.channels;
  target.assignments = src.assignments;
  target.autoSummaryEnabled = src.autoSummaryEnabled;
  target.keepRecent = src.keepRecent;
  target.autoHide = src.autoHide;
  target.leafBatchThreshold = src.leafBatchThreshold;
  target.resummaryThreshold = src.resummaryThreshold;
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
    // 把当前值(迁移来的或默认)写进 extension_settings,确立同步源
    ctx.extensionSettings[SETTINGS_KEY] = JSON.parse(JSON.stringify(apiSettings));
    ctx.saveSettingsDebounced?.();
    try {
      localStorage.removeItem(LEGACY_STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  ready = true;
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
    temperature: 0.7,
    maxTokens: 4096,
  };
}

export function getChannelForTask(task: TaskType): ApiChannel | null {
  const id = apiSettings.assignments[task];
  if (!id) return null;
  return apiSettings.channels.find(c => c.id === id) ?? null;
}
