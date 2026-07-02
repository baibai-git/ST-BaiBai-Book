/**
 * 向量化 / 重排的前端调用层。
 *
 * embedding 与 rerank 直接前端 fetch 上游(渠道 url/key 用户自填,与副 API 渠道独立)。
 * 走前端而非 ST 服务端代理:ST 的 /api/vector 端点绑定它自己的 source 配置,无法用我们
 * 独立配置的向量渠道;Horae 同样前端直连,已验证可行(代价是上游需允许跨域)。
 *
 * 兼容两种 embedding 端点:OpenAI /embeddings 与 Gemini batchEmbedContents(借鉴 Horae)。
 * 向量在前后端之间用 base64(float32 小端)传输。
 */

import type { VectorEndpoint } from '@/api/settings';
import { resolveVectorModel } from '@/api/settings';

export class EmbedError extends Error {}

/* ============ 超时 + 自动重试 ============ */

/** 重试前的固定退避(毫秒)。 */
const RETRY_BACKOFF_MS = 800;

/**
 * 带超时 + 自动重试的 fetch。向量上游常挂住不返回,裸 fetch 会一直干等——
 * 每次尝试都套一个 AbortController + 定时器,超时即中断;失败按类型决定是否重试:
 *  - 内部超时 / 网络异常 / 服务端 5xx / 限流 429 → 重试(还有次数时);
 *  - 4xx(鉴权/格式错等)→ 直接返回 resp,由调用方走既有 !resp.ok 抛错分支(重试无意义);
 *  - 外部 signal(用户取消生成)触发的中断 → 立即抛出,绝不重试(重试是浪费额度与时间)。
 * 返回 Response(可能 4xx,交调用方处理);重试耗尽仍失败则抛最后一次错误。
 */
export async function fetchWithTimeoutRetry(
  url: string,
  init: RequestInit,
  opts: { timeoutSec: number; retries: number; label: string; externalSignal?: AbortSignal },
): Promise<Response> {
  const { timeoutSec, retries, label, externalSignal } = opts;
  const maxAttempts = Math.max(1, 1 + Math.max(0, retries));
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // 外部已取消:不再尝试,直接抛(用户主动取消生成)
    if (externalSignal?.aborted) throw new EmbedError(`${label}已取消`);

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, Math.max(1000, timeoutSec * 1000));
    // 外部取消转发到内部 controller(fetch 只认一个 signal)
    const onExternalAbort = () => ctrl.abort();
    externalSignal?.addEventListener('abort', onExternalAbort);

    try {
      const resp = await fetch(url, { ...init, signal: ctrl.signal });
      // 5xx / 429 且还有重试机会 → 重试;其余(含 4xx)交调用方处理
      if ((resp.status >= 500 || resp.status === 429) && attempt < maxAttempts - 1) {
        lastErr = new EmbedError(`${label} API ${resp.status}`);
      } else {
        return resp;
      }
    } catch (e) {
      // 外部取消触发的 abort:立即抛,不重试
      if (externalSignal?.aborted && !timedOut) throw new EmbedError(`${label}已取消`);
      lastErr = timedOut
        ? new EmbedError(`${label}超时(>${timeoutSec}s)`)
        : new EmbedError(`${label}网络异常:${e instanceof Error ? e.message : String(e)}`);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    }

    // 到这说明本次要重试:还有次数则退避后再来
    if (attempt < maxAttempts - 1) {
      await new Promise(r => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }
  throw lastErr instanceof Error ? lastErr : new EmbedError(`${label}请求失败`);
}

/* ============ float32 ↔ base64 ============ */

/** Float32Array(或 number[]) → base64(小端字节序),用于上传后端存 BLOB */
export function encodeFloat32Base64(vec: number[] | Float32Array): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let bin = '';
  // 分块拼,避免超长 apply 爆栈
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** base64(小端 float32) → Float32Array */
export function decodeFloat32Base64(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

/* ============ endpoint 适配 ============ */

function isGeminiEndpoint(url: string, model: string): boolean {
  return /gemini|googleapis|generativelanguage|v1beta/i.test(`${url} ${model}`);
}

function isGoogleUrl(url: string): boolean {
  return /googleapis\.com|generativelanguage/i.test(url || '');
}

/** 去掉 url 尾部的 /chat/completions、/embeddings、/v1 等,得到 base */
function embeddingBase(url: string): string {
  return String(url || '')
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/embeddings$/i, '');
}

interface EmbeddingRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
  parse: (json: any) => number[][];
}

function buildEmbeddingRequest(ep: VectorEndpoint, model: string, texts: string[]): EmbeddingRequest {
  const url = ep.url;
  const key = ep.key || '';

  if (!isGeminiEndpoint(url, model)) {
    const base = embeddingBase(url);
    return {
      endpoint: `${base}/embeddings`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, input: texts }),
      parse: (json) => {
        if (!json?.data || !Array.isArray(json.data)) throw new EmbedError('embedding 返回缺少 data 数组');
        return json.data.slice().sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding);
      },
    };
  }

  // Gemini batchEmbedContents
  const base = embeddingBase(url).replace(/\/v\d+(beta\d*|alpha\d*)?(?:\/.*)?$/i, '');
  const modelName = model.startsWith('models/') ? model : `models/${model}`;
  const google = isGoogleUrl(base);
  const endpoint = `${base}/v1beta/${modelName}:batchEmbedContents${google ? `?key=${encodeURIComponent(key)}` : ''}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (!google) headers.Authorization = `Bearer ${key}`;
  return {
    endpoint,
    headers,
    body: JSON.stringify({ requests: texts.map((text) => ({ model: modelName, content: { parts: [{ text }] } })) }),
    parse: (json) => {
      if (!json?.embeddings || !Array.isArray(json.embeddings)) throw new EmbedError('Gemini embedding 返回缺少 embeddings 数组');
      return json.embeddings.map((e: any) => e.values);
    },
  };
}

/* ============ 对外:embed / rerank ============ */

/** 单次 embedding 请求最多塞几条文本(多数上游 batch 上限 ≤64,取保守值分批)。 */
const EMBED_BATCH = 64;

/** 发一批(≤EMBED_BATCH)文本的 embedding 请求,返回向量数组(顺序对应)。 */
async function embedBatch(ep: VectorEndpoint, model: string, texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const req = buildEmbeddingRequest(ep, model, texts);
  const resp = await fetchWithTimeoutRetry(
    req.endpoint,
    { method: 'POST', headers: req.headers, body: req.body },
    { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'embedding', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`embedding API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const vectors = req.parse(json);
  if (!Array.isArray(vectors) || vectors.some((v) => !Array.isArray(v))) {
    throw new EmbedError('embedding 返回的向量数据无效');
  }
  return vectors.map((v) => Float32Array.from(v));
}

/**
 * 向量化一批文本,返回 Float32Array[](顺序与输入对应)。渠道未配齐则抛错。
 * 超过 EMBED_BATCH 条自动切片分批串行请求(上游单次 batch 有上限,补建几百条时必走多批)。
 */
export async function embedTexts(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const ep = resolveVectorModel('embedding');
  if (!ep.url) throw new EmbedError('向量记忆:Embedding 地址未配置');
  if (!ep.model) throw new EmbedError('向量记忆:Embedding 模型未配置');

  if (texts.length <= EMBED_BATCH) return embedBatch(ep, ep.model, texts, signal);

  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const part = await embedBatch(ep, ep.model, texts.slice(i, i + EMBED_BATCH), signal);
    out.push(...part);
  }
  return out;
}

/** 向量化单条文本 → base64,索引/检索时用。 */
export async function embedToBase64(text: string, signal?: AbortSignal): Promise<string> {
  const [v] = await embedTexts([text], signal);
  if (!v) throw new EmbedError('embedding 返回为空');
  return encodeFloat32Base64(v);
}

export interface RerankResult {
  index: number;
  score: number;
}

/* ============ rerank token 估算 / 分批(借鉴 Horae,全文精排时单请求会超上游上下文) ============ */

/** rerank 上游单请求的上下文上限(token);多数 rerank 模型 32k 起,取保守值。 */
const RERANK_CONTEXT_LIMIT = 32768;
const RERANK_SAFE_RATIO = 0.68; // 仅用预算的 68%,给 prompt 模板/响应留余量
const RERANK_STATIC_RESERVE = 1800; // 固定保留(模型框架开销)
const RERANK_PER_DOC_OVERHEAD = 24; // 每条文档的分隔/包裹开销

/** 粗估文本 token:CJK ≈1.35、其它 ≈0.45,再加安全系数(对齐 Horae,宁可高估)。 */
function estimateRerankTokens(text: string): number {
  if (!text) return 0;
  const str = String(text);
  let cjk = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0xac00 && cp <= 0xd7af)
    ) cjk++;
  }
  const other = Math.max(0, str.length - cjk);
  return Math.ceil((cjk * 1.35 + other * 0.45 + 8) * 1.18);
}

/** 二分截断到 token 上限内(保留前缀)。 */
function truncateByTokens(text: string, tokenLimit: number): string {
  if (!text || tokenLimit <= 0) return '';
  if (estimateRerankTokens(text) <= tokenLimit) return text;
  let lo = 0, hi = text.length, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (estimateRerankTokens(text.slice(0, mid)) <= tokenLimit) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return text.slice(0, best).trimEnd();
}

/** rerank 分批并发上限(批次再多也只同时打这么多请求)。 */
const RERANK_BATCH_CONCURRENCY = 4;

interface RerankBatch {
  indices: number[]; // 该批每条文档的全局下标
  documents: string[];
}

/** 按 token 预算把文档切成多批,超长单条先截断。 */
function buildRerankBatches(query: string, documents: string[]): RerankBatch[] {
  const queryTokens = estimateRerankTokens(query);
  const docBudget = Math.max(1024, Math.floor(RERANK_CONTEXT_LIMIT * RERANK_SAFE_RATIO) - RERANK_STATIC_RESERVE - queryTokens);
  const maxSingleDocTokens = Math.max(768, docBudget - 256);

  const batches: RerankBatch[] = [];
  let curIdx: number[] = [], curDocs: string[] = [], curTokens = 0;
  const flush = () => {
    if (!curIdx.length) return;
    batches.push({ indices: curIdx, documents: curDocs });
    curIdx = []; curDocs = []; curTokens = 0;
  };

  for (let i = 0; i < documents.length; i++) {
    let text = documents[i] ?? '';
    let est = estimateRerankTokens(text) + RERANK_PER_DOC_OVERHEAD;
    if (est > maxSingleDocTokens) {
      text = truncateByTokens(text, Math.max(512, maxSingleDocTokens - RERANK_PER_DOC_OVERHEAD));
      est = estimateRerankTokens(text) + RERANK_PER_DOC_OVERHEAD;
    }
    if (curIdx.length && curTokens + est > docBudget) flush();
    curIdx.push(i);
    curDocs.push(text);
    curTokens += est;
  }
  flush();
  return batches;
}

/** 单批 rerank 请求,返回该批内 {index(局部), score}。 */
async function rerankBatch(
  endpoint: string, model: string, key: string, query: string, documents: string[],
  timeoutSec: number, retries: number, signal?: AbortSignal,
): Promise<RerankResult[]> {
  const resp = await fetchWithTimeoutRetry(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, query, documents, top_n: documents.length }),
    },
    { timeoutSec, retries, label: 'rerank', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new EmbedError(`rerank API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const results = json?.results ?? json?.data;
  if (!Array.isArray(results)) throw new EmbedError('rerank 返回缺少 results 数组');
  return results.map((r: any) => ({ index: r.index, score: r.relevance_score ?? r.score ?? 0 }));
}

/**
 * 重排:把候选文档(全文精排时即楼层原文)按与 query 的相关度打分。
 * 返回按 score 降序的 {index, score}(index = 输入 documents 的全局下标)。
 * 文档总量超 rerank 上下文预算时自动按 token 分批、超长单条截断,各批结果按全局下标合并。
 * rerank 渠道未配齐时抛错(由调用方决定降级:跳过 rerank、直接用 embedding 序)。
 */
export async function rerankDocuments(
  query: string,
  documents: string[],
  _topN: number,
  signal?: AbortSignal,
): Promise<RerankResult[]> {
  if (!documents.length) return [];
  const ep = resolveVectorModel('rerank');
  if (!ep.url) throw new EmbedError('向量记忆:Rerank 地址未配置');
  if (!ep.model) throw new EmbedError('向量记忆:Rerank 模型未配置');

  const endpoint = `${embeddingBase(ep.url)}/rerank`;
  const batches = buildRerankBatches(query, documents);
  const key = ep.key || '';
  const model = ep.model;

  // worker 池并发:批次再多也只同时打 RERANK_BATCH_CONCURRENCY 个请求,各批结果按全局下标合并。
  const merged: RerankResult[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const bi = next++;
      if (bi >= batches.length) break;
      const batch = batches[bi];
      const local = await rerankBatch(endpoint, model, key, query, batch.documents, ep.timeoutSec, ep.retries, signal);
      for (const r of local) {
        const globalIndex = batch.indices[r.index];
        if (globalIndex === undefined) continue;
        merged.push({ index: globalIndex, score: r.score });
      }
    }
  };
  const poolSize = Math.min(RERANK_BATCH_CONCURRENCY, batches.length);
  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return merged.sort((a, b) => b.score - a.score);
}
