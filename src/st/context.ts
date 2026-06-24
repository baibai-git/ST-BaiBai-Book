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

export interface STContext {
  chat: STMessage[];
  chatMetadata: Record<string, unknown>;
  name1: string;
  name2: string;
  getCurrentChatId: () => string | undefined;
  getRequestHeaders: () => Record<string, string>;
  saveMetadataDebounced: () => void;
  saveMetadata: () => Promise<void>;
  saveChat: () => Promise<void>;
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
