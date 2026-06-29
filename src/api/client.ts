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

  const stream = channel.stream ?? false;
  // 预填充开关(默认开):关闭时丢掉末尾那条 assistant 预填充消息。
  // 摘要/批量请求会在末尾追加一条 assistant 预填充引导思维链;对不支持预填充(不续写)的端点
  // 形同浪费、个别端点还要求「最后一条须为 user」。关掉只是不发它,思维链引导仍由 system 清单承担。
  const outMessages =
    channel.prefill === false && messages[messages.length - 1]?.role === 'assistant'
      ? messages.slice(0, -1)
      : messages;
  const body: Record<string, unknown> = {
    chat_completion_source: 'openai',
    reverse_proxy: normalizeUrl(channel.url),
    proxy_password: channel.key || '',
    model: channel.model,
    messages: outMessages,
    temperature: channel.temperature ?? 1.0,
    max_tokens: channel.maxTokens ?? 8192,
    stream,
    // 静默:不影响主对话状态
    presence_penalty: 0,
    frequency_penalty: 0,
  };

  // 排除参数:把用户指定的字段从 body 删掉,规避不接受这些参数的兼容端点报错。
  // 注:固定路由字段(chat_completion_source/reverse_proxy 等)不应被删,但全凭用户填写,
  // 这里只做忠实剔除——文案会提示填采样参数名(temperature/max_tokens/...)。
  for (const p of channel.excludeParams ?? []) {
    const key = p.trim();
    if (key) delete body[key];
  }

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

  // 流式:按 SSE 增量拼接;非流式:直接解析 JSON。
  if (stream) {
    const content = await readSseContent(resp);
    if (!content) throw new ApiError('副 API 返回空内容');
    return content;
  }

  const data = await resp.json();
  if (data?.error) {
    throw new ApiError(data.error.message || '副 API 返回错误');
  }

  const content = extractContent(data);
  if (!content) throw new ApiError('副 API 返回空内容');
  return content;
}

/**
 * 读取 SSE 流(text/event-stream),拼接 delta.content。
 * ST 的 generate 端点在 stream=true 时透传上游 SSE:每行 `data: {json}`,以 `data: [DONE]` 结束。
 */
async function readSseContent(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) {
    // 无法流式读取(理论上不会):退回当作整体 JSON 处理
    const data = await resp.json().catch(() => null);
    return data ? extractContent(data) : '';
  }
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // 按行解析,保留最后一段不完整的行到下次
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t || !t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        if (json?.error) throw new ApiError(json.error.message || '副 API 返回错误');
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? json?.choices?.[0]?.text;
        if (typeof delta === 'string') out += delta;
      } catch (e) {
        if (e instanceof ApiError) throw e;
        // 单行解析失败忽略(可能是注释行/心跳)
      }
    }
  }
  return out.trim();
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

/* ============ 跟随主 API(主界面当前在用的 API 设置) ============ */

/** 摘要/总结跟随主 API 时的响应上限:够装下思维链 + JSON,避免被主 API 默认 max tokens 截断。 */
const MAIN_API_RESPONSE_LENGTH = 8192;

/**
 * 是否具备「跟随主 API」的条件:ST 暴露了 generateRaw(稳定 API)即可。
 * 不再依赖连接管理/连接档——直接借用主界面当前正在用的 API。
 */
export function mainApiAvailable(): boolean {
  return typeof getContext()?.generateRaw === 'function';
}

/**
 * 用「当前主 API」(主界面正在用的聊天补全/文本补全设置)发一次补全。
 * 走 ST 的 generateRaw:只发我们给的这几条消息,不带聊天历史/角色卡;无需连接档。
 * quiet 类型内部强制非流式,返回清洗后的整段文本;失败抛 ApiError。
 */
export async function requestViaMainApi(messages: ChatMsg[], _opts: RequestOptions = {}): Promise<string> {
  const ctx = getContext();
  if (typeof ctx?.generateRaw !== 'function') {
    throw new ApiError('当前 ST 版本不支持 generateRaw,无法跟随主 API');
  }
  const content = (await ctx.generateRaw({ prompt: messages, responseLength: MAIN_API_RESPONSE_LENGTH }))?.trim();
  if (!content) throw new ApiError('主 API 返回空内容');
  return content;
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
