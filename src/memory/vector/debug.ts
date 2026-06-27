/**
 * 向量召回调试快照(全局,reactive)。
 *
 * 只为「设置 → 向量记忆 → 上次召回详情」面板服务:把上一次召回各阶段的中间结果
 * 留一份在内存里供 UI 订阅。纯调试观测,不参与召回逻辑,失败/降级也照样记录(写明 status)。
 * 全局单例(非按聊天):只关心「最近一次」,切聊天后下一次召回自然覆盖。
 */

import { reactive } from 'vue';

/** Embedding 检索命中(后端 max 融合后) */
export interface RecallDebugEmbedHit {
  leafId: string;
  similarity: number;
  /** 来源 Q 下标(后端回传);-1 = 未知(旧后端未回传) */
  queryIndex: number;
  /** 来源标记:本聊天命中为楼层号「#5」,bundle 快照为「旧档」 */
  source: string;
  storyTime: string;
  preview: string;
}

/** Rerank 候选及其分档结果 */
export interface RecallDebugRerankHit {
  leafId: string;
  rerankScore: number;
  similarity: number;
  /** 分档:full=发全文,brief=发摘要,drop=两档都不达标被丢弃 */
  tier: 'full' | 'brief' | 'drop';
  /** 来源标记:本聊天命中为楼层号「#5」,bundle 快照为「旧档」 */
  source: string;
  storyTime: string;
  preview: string;
}

export interface RecallDebug {
  /** 记录时刻(Date.now);0 = 尚无记录 */
  at: number;
  /** 状态文案:'召回完成' | '进行中…' | '未召回:…' | '失败:…' */
  status: string;
  /** 查询重写的场景意图(兼作 rerank query) */
  intent: string;
  /** 查询重写产出的多条检索 query */
  queries: string[];
  embedding: RecallDebugEmbedHit[];
  rerank: RecallDebugRerankHit[];
  /** 最终注入主对话的文本(空 = 本回合未注入) */
  injectedText: string;
}

function empty(): RecallDebug {
  return { at: 0, status: '', intent: '', queries: [], embedding: [], rerank: [], injectedText: '' };
}

/** 全局召回调试快照。UI 直接订阅;recall.ts 在各阶段写入。 */
export const recallDebug = reactive<RecallDebug>(empty());

/** 摘要预览:取摘要文本截断,供面板单行展示(去换行,限长)。 */
export function previewOf(text: string | null | undefined, max = 80): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 开一次新召回:清空各阶段、置「进行中」。在 runVectorRecall 进入有效路径后调用。 */
export function resetRecallDebug(): void {
  Object.assign(recallDebug, empty(), { at: Date.now(), status: '进行中…' });
}

/** 仅更新状态文案(各早退路径写明原因,如「未召回:Query 重写未配置」)。 */
export function setRecallStatus(status: string): void {
  recallDebug.status = status;
  if (!recallDebug.at) recallDebug.at = Date.now();
}

export function setRecallRewrite(intent: string, queries: string[]): void {
  recallDebug.intent = intent;
  recallDebug.queries = [...queries];
}

export function setRecallEmbedding(hits: RecallDebugEmbedHit[]): void {
  recallDebug.embedding = hits;
}

export function setRecallRerank(hits: RecallDebugRerankHit[]): void {
  recallDebug.rerank = hits;
}

export function setRecallInjected(text: string): void {
  recallDebug.injectedText = text;
}

/** 快照当前调试结果(深拷贝),供召回缓存留存,命中时再 restore 回面板。 */
export function snapshotRecallDebug(): RecallDebug {
  return JSON.parse(JSON.stringify(recallDebug));
}

/** 把缓存的调试快照还原到面板(命中缓存时用,免得 reset 后面板空白)。 */
export function restoreRecallDebug(snap: RecallDebug): void {
  Object.assign(recallDebug, snap);
}
