import { reactive, watch } from 'vue';

/**
 * 副 API 设置(全局,跨聊天)。存 localStorage。
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

export interface ApiSettings {
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

const STORAGE_KEY = 'bbs.api.v1';

function defaults(): ApiSettings {
  return {
    channels: [],
    assignments: { summary: '', resummary: '' },
    autoSummaryEnabled: false,
    keepRecent: 5,
    autoHide: true,
    leafBatchThreshold: 12,
    resummaryThreshold: 7,
  };
}

function load(): ApiSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults();
    return { ...defaults(), ...JSON.parse(raw) };
  } catch {
    return defaults();
  }
}

export const apiSettings = reactive<ApiSettings>(load());

watch(
  apiSettings,
  () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(apiSettings));
    } catch {
      /* ignore */
    }
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
