import { getContext } from '@/st/context';
import type { ApiChannel } from './settings';

/**
 * 通过 SillyTavern 的服务端代理调用任意 OpenAI 兼容端点。
 *
 * 关键:以 chat_completion_source='openai' + reverse_proxy(base url)+ proxy_password(key)
 * 走 /api/backends/chat-completions/generate。请求由 ST 服务端转发,
 * 因此没有浏览器 CORS 问题,也无需把密钥存进 ST 的 secrets。
 */

const GENERATE_URL = '/api/backends/chat-completions/generate';

export interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {}

/** 规范化 base url:确保以 /v1 结尾(多数 OpenAI 兼容服务需要) */
function normalizeUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!u) return u;
  if (!/\/v\d+$/.test(u) && !/\/chat\/completions$/.test(u)) {
    u += '/v1';
  }
  // 端点期望 base(不含 /chat/completions),去掉它
  u = u.replace(/\/chat\/completions$/, '');
  return u;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * 发起一次补全请求,返回文本内容。
 */
export async function requestCompletion(
  channel: ApiChannel,
  messages: ChatMsg[],
  opts: RequestOptions = {},
): Promise<string> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url || !channel.model) throw new ApiError('副 API 渠道未配置完整(缺 url 或 model)');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
    model: channel.model,
    messages,
    temperature: channel.temperature ?? 0.7,
    max_tokens: channel.maxTokens ?? 4096,
    stream: false,
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  const resp = await fetch(GENERATE_URL, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(`副 API 请求失败 (${resp.status}): ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  if (data?.error) {
    throw new ApiError(data.error.message || '副 API 返回错误');
  }

  const content = extractContent(data);
  if (!content) throw new ApiError('副 API 返回空内容');
  return content;
}

/** 从标准 OpenAI 响应体提取文本 */
function extractContent(data: any): string {
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    data?.content ??
    ''
  ).trim();
}

/** 连通性测试:发一条极短请求 */
export async function testChannel(channel: ApiChannel): Promise<{ ok: boolean; message: string }> {
  try {
    const reply = await requestCompletion(channel, [{ role: 'user', content: '回复"ok"两个字符即可。' }]);
    return { ok: true, message: `连通正常,返回:${reply.slice(0, 40)}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

const STATUS_URL = '/api/backends/chat-completions/status';

/**
 * 拉取渠道可用的模型列表(走 ST 的 /status 代理,标准 /v1/models)。
 * 只需 url + key,不需要先填 model。
 */
export async function fetchModels(channel: Pick<ApiChannel, 'url' | 'key'>): Promise<string[]> {
  const ctx = getContext();
  if (!ctx) throw new ApiError('SillyTavern 上下文不可用');
  if (!channel.url) throw new ApiError('请先填写 API 地址');

  const body = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
  };

  const resp = await fetch(STATUS_URL, {
    method: 'POST',
    headers: ctx.getRequestHeaders(),
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new ApiError(`拉取模型失败 (${resp.status}): ${text.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (data?.error && !Array.isArray(data?.data)) {
    throw new ApiError(data?.message || '拉取模型失败');
  }

  const list: unknown = data?.data ?? data?.models ?? [];
  if (!Array.isArray(list)) return [];
  return list
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((x: unknown): x is string => typeof x === 'string' && x.length > 0)
    .sort();
}
