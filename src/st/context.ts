/**
 * SillyTavern getContext() 的薄封装 + 类型。
 * 整个扩展只通过这里接触宿主,稳定且单点。
 * 运行时 getContext 挂在 window.SillyTavern 上(ST 的稳定扩展 API)。
 */

export interface STMessage {
  name: string;
  is_user: boolean;
  is_system: boolean;
  mes: string;
  send_date?: string;
  /** 当前显示的 swipe 页码(多页 AI 回复时)。单页/无 swipe 时可能为 undefined,按 0 处理 */
  swipe_id?: number;
  /** 消息私有数据。柏宝书在这里存 bbs_hidden(隐藏标记) 与 bbs_leaf(叶子摘要) */
  extra?: Record<string, unknown> & { bbs_leaf?: import('@/memory/types').LeafExtra; bbs_hidden?: boolean };
}

export interface STEventSource {
  on(event: string, handler: (...args: any[]) => void): void;
  off?(event: string, handler: (...args: any[]) => void): void;
  emit?(event: string, ...args: any[]): Promise<void> | void;
}

export interface STEventTypes {
  USER_MESSAGE_RENDERED: string;
  CHARACTER_MESSAGE_RENDERED: string;
  MESSAGE_SENT: string;
  GENERATION_STARTED: string;
  GENERATION_ENDED: string;
  MESSAGE_SWIPED: string;
  CHAT_CHANGED: string;
  [k: string]: string;
}

/** 角色卡(只用到极少字段;avatar 是稳定唯一键,name 可能重名) */
export interface STCharacter {
  name: string;
  avatar: string;
  [k: string]: unknown;
}

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  /** 已加载的全部角色卡 */
  characters?: STCharacter[];
  /** 当前角色在 characters 中的索引(字符串/数字);群聊时为空 */
  characterId?: string | number;
  /** 当前群组 id;非群聊为空 */
  groupId?: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
  /** 扩展全局设置对象(= extension_settings,写进服务器 settings.json,跨设备同步)。ST 稳定 API。 */
  extensionSettings?: Record<string, unknown>;
  /** 防抖保存全局设置(连同 extensionSettings 落盘到服务器)。ST 稳定 API。 */
  saveSettingsDebounced?: () => void;
  reloadCurrentChat: () => Promise<void>;
  eventSource: STEventSource;
  eventTypes: STEventTypes;
  /** 注入扩展提示(key, value, position, depth, scan, role, filter)。ST 稳定 API。 */
  setExtensionPrompt?: (
    key: string,
    value: string,
    position: number,
    depth: number,
    scan?: boolean,
    role?: number,
    filter?: unknown,
  ) => void;
  /** 执行斜杠命令(如 /hide 0-3)。ST 稳定 API。 */
  executeSlashCommandsWithOptions?: (command: string, options?: Record<string, unknown>) => Promise<unknown>;
  /**
   * 连接管理:用「当前选中的连接档」发请求(跟随主 API)。来源 extensions/shared.js。
   * sendRequest(profileId, messages, maxTokens, custom, overridePayload):
   *   custom.includePreset=false → 不套补全预设(只用该档的 API 信息);
   *   custom.includeInstruct=false → 文本补全档也跳过 instruct 模板;
   *   overridePayload 可塞 temperature 等采样参数(因为不走预设)。
   *   extractData=true(默认)时返回 { content } 取文本。
   */
  ConnectionManagerRequestService?: {
    sendRequest: (
      profileId: string,
      prompt: Array<{ role: string; content: string }> | string,
      maxTokens: number,
      custom?: {
        stream?: boolean;
        signal?: AbortSignal | null;
        extractData?: boolean;
        includePreset?: boolean;
        includeInstruct?: boolean;
      },
      overridePayload?: Record<string, unknown>,
    ) => Promise<unknown>;
  };
  /**
   * 按文本激活世界书条目(关键词触发 + constant 常驻)。ST 稳定 API(world-info.js)。
   * chat 为待扫描文本数组(由旧到新);isDryRun=true 仅扫描不触发副作用事件。
   */
  getWorldInfoPrompt?: (
    chat: string[],
    maxContext: number,
    isDryRun: boolean,
    globalScanData?: Record<string, unknown>,
  ) => Promise<{
    worldInfoBefore?: string;
    worldInfoAfter?: string;
    worldInfoString?: string;
    /** @深度条目:{depth, role, entries: string[]}。很多蓝灯条目在这里 */
    worldInfoDepth?: Array<{ depth?: number; role?: number; entries?: string[] }>;
    /** 作者注前/后条目(content 字符串数组) */
    anBefore?: string[];
    anAfter?: string[];
  }>;
  /** 主上下文最大 token(给 getWorldInfoPrompt 的预算参数) */
  maxContext?: number;
  // 兼容旧式命名
  event_types?: STEventTypes;
  [k: string]: any;
}

interface STGlobal {
  getContext: () => STContext;
}

declare global {
  interface Window {
    SillyTavern?: STGlobal;
  }
}

/** 取得 ST 上下文;未就绪时返回 null。 */
export function getContext(): STContext | null {
  try {
    return window.SillyTavern?.getContext?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * 取 ST 的 doNewChat(getContext 未暴露,从 /script.js 动态取)。
 * 用于「带数据创建新对话」:doNewChat({deleteCurrentChat:false}) 在当前角色下新建一个空聊天并切入。
 * 取不到(旧版/路径变动)时返回 null,调用方据此降级报错。
 */
export async function getDoNewChat(): Promise<((opts?: { deleteCurrentChat?: boolean }) => Promise<void>) | null> {
  try {
    // 变量持有路径,避免 Vite/vue-tsc 把 /script.js 当本地模块解析
    const scriptPath = '/script.js';
    const mod: Record<string, unknown> = await import(/* @vite-ignore */ scriptPath);
    const fn = mod.doNewChat;
    return typeof fn === 'function' ? (fn as (opts?: { deleteCurrentChat?: boolean }) => Promise<void>) : null;
  } catch {
    return null;
  }
}
