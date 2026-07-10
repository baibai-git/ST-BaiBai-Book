/**
 * 向量召回的查询重写(Query Rewrite)。
 *
 * 复刻 Horae 的「小模型把当前剧情重写成 INTENT + 多条检索 Q」思路与提示词(用户已优化版),
 * 但**上下文构造是柏宝书自己的**(见 .carryover-plan.md「查询重写上下文构造」):
 *  结构 = [历史剧情摘要] + 最近窗口全文 + [状态快照] + [用户输入]
 *  - 状态一律走 deriveMemory(不假设 getLatestState 干净);
 *  - 状态快照精确放置:从窗口起点扫到第一个「无有效叶子」的楼停下,
 *    快照 = deriveMemory(chat, 洞楼index),插在「连续叶子前缀末尾」之后、洞楼之前;
 *  - 快照只含**滚出窗口的主角档案/items/plans**(时间/地点/在场已在全文里,不重复)。
 *
 * 产出多条 query,各自 embed → 后端 vec/search 多路检索 + RRF 融合;INTENT 兼作 rerank 的 query。
 * 任何失败都抛错,由召回侧 catch 后降级为「最近上下文当单 query」。
 */

import type { STMessage } from '@/st/context';
import { getContext } from '@/st/context';
import { apiSettings, resolveVectorModel } from '@/api/settings';
import { deriveMemory, getLeaf, leafValid } from '../apply';
import { resolveKeepStart } from '../engine';
import { renderHistoryNodes, selectHistoryNodesBefore } from '../inject';
import { fmtItems, fmtNpcs, fmtPlans, fmtProtagonist, JAILBREAK_PROMPT, QUERY_REWRITE_SYSTEM, QUERY_REWRITE_TAIL } from '../prompts';
import { memory } from '../store';
import { cleanBody } from '../timeTag';
import { fetchWithTimeoutRetry } from './embed';

/** rewrite 模型最多取几条 query(对齐 Horae) */
const MAX_QUERIES = 6;
/** 单条 query 限长 */
const MAX_QUERY_LEN = 220;

export interface RewriteResult {
  /** 场景意图描述(兼作 rerank 的 query) */
  intent: string;
  /** 多条检索 query(已去重限长) */
  queries: string[];
}

interface ChatMsg {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 把楼层正文清洗成可读文本,与喂摘要模型同口径(cleanBody:裁正文段 + 整块删噪声标签 + 时间转文本)。 */
function cleanFloor(m: STMessage): string {
  return cleanBody(m.mes);
}

/**
 * 构造状态快照文本(只含滚出窗口、长期有效的 items/plans)。
 * upTo = 第一个无叶子楼的索引(快照截到它之前)。无有意义内容返回空串。
 */
function buildStateSnapshot(chat: STMessage[], upTo: number): string {
  const st = deriveMemory(chat, upTo);
  const lines: string[] = [];
  if (Object.values(st.protagonist).some(Boolean)) {
    lines.push(`主角当前档案:\n${fmtProtagonist(st.protagonist)}`);
  }
  if (st.items.length) {
    lines.push(`物品清单:\n${fmtItems(st.items.map(i => ({ name: i.name, qty: i.qty, desc: i.desc, carried: i.carried, location: i.location })))}`);
  }
  if (st.npcs.length) {
    lines.push(`NPC名册:\n${fmtNpcs(st.npcs.map(n => ({ name: n.name, gender: n.gender, title: n.title, follow: n.follow, location: n.location })))}`);
  }
  const openPlans = st.plans.filter(p => p.status === 'open');
  if (openPlans.length) {
    lines.push(`未了结的计划/悬念:\n${fmtPlans(openPlans.map(p => ({ kind: p.kind, content: p.content, createdTime: p.createdTime, targetTime: p.targetTime })))}`);
  }
  if (!lines.length) return '';
  return `[状态快照:以下为已滚出最近窗口、但仍有效的主角档案、物品、NPC 与未了结计划,供你解析模糊指代]\n${lines.join('\n')}`;
}

/**
 * 找状态快照的插入点:从窗口起点向后扫,返回第一个「无有效叶子」楼的索引。
 * 全部有叶子则返回 chat.length(快照截到全部窗口,放最末)。
 */
function findSnapshotCut(chat: STMessage[], windowStart: number): number {
  for (let i = windowStart; i < chat.length; i++) {
    if (chat[i]?.extra?.bbs_omit) continue;
    if (!leafValid(chat[i])) return i;
  }
  return chat.length;
}

/**
 * 构造发给 rewrite 模型的消息序列。
 *
 * ⚠️ 许多向量渠道要求 system 消息**仅允许出现在数组最开头**,中间不得再有 system。
 * 故对齐 Horae 的形态:**开头唯一一条 system + 中间纯 user/assistant 对话 + 结尾一条 user**。
 *  - 历史剧情摘要并入开头那条 system(属背景设定,合法地待在开头);
 *  - 状态快照不独立成 system,而是**拼进对话消息正文**(放在 cut 点前一条之后、洞楼之前),
 *    保持中间无 system,从而兼容「system 只能在开头」的渠道。
 */
function buildMessages(chat: STMessage[]): ChatMsg[] {
  const windowStart = resolveKeepStart(chat);
  const cut = findSnapshotCut(chat, windowStart);

  // 开头唯一 system:系统提示词 +(可选)历史剧情摘要,合并为一条,保证 system 只出现在开头
  const history = renderHistoryNodes(selectHistoryNodesBefore(memory.summaries, chat, windowStart));
  let systemContent = history ? `${QUERY_REWRITE_SYSTEM}\n\n[历史剧情摘要]\n${history}` : QUERY_REWRITE_SYSTEM;
  // 启用破限:把破限提示词置顶拼进开头这条唯一 system 的最前面。
  // 不新增一条 system,以守住「system 仅允许出现在数组最开头」的渠道约束——拼进即等于「最开头 + system 身份」。
  // 破限文本取自「自定义提示词 · 破限」,留空则回退内置默认(与摘要/总结两端同口径,见 engine.ts)。
  if (apiSettings.vector.queryRewriteJailbreak) {
    const jb = apiSettings.prompts.jailbreak.trim() || JAILBREAK_PROMPT;
    if (jb) systemContent = `${jb}\n\n${systemContent}`;
  }
  const messages: ChatMsg[] = [{ role: 'system', content: systemContent }];

  // 平铺窗口对话(纯 user/assistant),记录原 msgIndex 以定位快照插入点
  const convo: Array<{ role: 'user' | 'assistant'; content: string; index: number }> = [];
  for (let i = windowStart; i < chat.length; i++) {
    const m = chat[i];
    if (!m) continue;
    if (m.extra?.bbs_omit) continue;
    if (m.is_system && m.extra?.type) continue; // 原生系统楼跳过
    const text = cleanFloor(m);
    if (!text) continue;
    convo.push({ role: m.is_user ? 'user' : 'assistant', content: text, index: i });
  }

  // 状态快照:拼进对话消息正文(不独立成 system)。语义 = 截止 cut(第一个无叶子楼)之前的确凿状态。
  const snapshot = buildStateSnapshot(chat, cut);
  if (snapshot) {
    if (!convo.length) {
      // 窗口无可用对话消息 → 兜底放一条 user 承载(仍非 system)
      messages.push({ role: 'user', content: snapshot });
    } else {
      const cutPos = convo.findIndex(c => c.index >= cut);
      if (cutPos === -1) {
        // cut 在所有对话之后(窗口全有叶子)→ 拼进最后一条末尾
        const last = convo[convo.length - 1];
        last.content = `${last.content}\n\n${snapshot}`;
      } else if (cutPos === 0) {
        // cut 点即首条对话(之前无对话可承载)→ 拼进它的前缀
        convo[0].content = `${snapshot}\n\n${convo[0].content}`;
      } else {
        // 拼进 cut 点前一条对话的末尾(连续叶子前缀末尾之后、洞楼之前)
        const prev = convo[cutPos - 1];
        prev.content = `${prev.content}\n\n${snapshot}`;
      }
    }
  }

  for (const c of convo) messages.push({ role: c.role, content: c.content });

  // 收尾提示词
  messages.push({ role: 'user', content: QUERY_REWRITE_TAIL });
  return messages;
}

/** base url 规整到 /chat/completions 端点 */
function chatCompletionsEndpoint(rawUrl: string): string {
  const base = String(rawUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/embeddings$/i, '')
    .replace(/\/chat\/completions$/i, '');
  return base ? `${base}/chat/completions` : '';
}

/** 解析 INTENT + 多行 Q(对齐 Horae:去前缀符号、去重、限长) */
function parseResponse(text: string): RewriteResult {
  const lines = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\\n/g, '\n')
    // 双保险:即便请求关了 enable_thinking,个别模型仍会吐 <think> 块,先整段剥掉再逐行解析,
    // 否则思维链里出现的 INTENT/Q 字样会污染解析结果。
    .replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let intent = '';
  const queries: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    // 去掉行首的 -/*/•、数字编号
    const line = raw.replace(/^\s*(?:[-*•]\s*)?(?:\d+[.)、]\s*)?/, '').trim();
    const im = line.match(/^INTENT\s*[:：]\s*(.+)$/i);
    if (im) {
      intent = sanitize(im[1]);
      continue;
    }
    const qm = line.match(/^Q\s*\d*\s*[:：]\s*(.+)$/i);
    if (qm) {
      const q = sanitize(qm[1]);
      if (!q) continue;
      const key = q.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push(q);
      if (queries.length >= MAX_QUERIES) break;
    }
  }
  return { intent, queries };
}

function sanitize(text: string): string {
  return String(text || '')
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_QUERY_LEN);
}

/**
 * 执行查询重写。queryRewrite 端点未配 model 时抛错(调用方降级)。
 * 走前端直连 chat/completions(与 embed 同源策略,渠道地址/密钥可留空复用 embedding)。
 */
export async function rewriteQuery(signal?: AbortSignal): Promise<RewriteResult> {
  const ep = resolveVectorModel('queryRewrite');
  if (!ep.model) throw new Error('Query 重写模型未配置');
  const endpoint = chatCompletionsEndpoint(ep.url);
  if (!endpoint) throw new Error('Query 重写地址未配置');

  const ctx = getContext();
  const chat = ctx?.chat ?? [];
  if (!chat.length) throw new Error('无对话上下文可重写');

  const messages = buildMessages(chat);

  const resp = await fetchWithTimeoutRetry(
    endpoint,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key || ''}` },
      body: JSON.stringify({
        model: ep.model,
        messages,
        // 对齐 Horae:低温更服从格式;enable_thinking:false 关思维链——
        // 国产模型(Qwen3/GLM 等)默认开思维链会先吐 <think> 推理,冲乱 INTENT/Q 行格式导致解析失败。
        temperature: 0.1,
        top_p: 0.8,
        max_tokens: apiSettings.vector.queryRewriteMaxTokens,
        stream: false,
        enable_thinking: false,
      }),
    },
    { timeoutSec: ep.timeoutSec, retries: ep.retries, label: 'Query 重写', externalSignal: signal },
  );
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Query 重写 API ${resp.status}: ${t.slice(0, 200)}`);
  }
  const json = await resp.json();
  const content = json?.choices?.[0]?.message?.content;
  const raw = typeof content === 'string' ? content : '';
  if (!raw.trim()) throw new Error('Query 重写返回空内容');

  const parsed = parseResponse(raw);
  if (!parsed.queries.length) throw new Error('Query 重写未解析出任何检索 query');
  return parsed;
}
