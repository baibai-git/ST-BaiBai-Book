import { getContext, type STMessage } from '@/st/context';
import { memory, recomputeDerived, saveMemory, scheduleLeafFlush } from './store';
import { createEmptyMemory } from './types';
import type { BaibaiMemory, LeafExtra, MemPlan, MemSummary, StoredDelta, SummaryDelta } from './types';

let idSeq = 0;
/** 生成稳定唯一 id(不依赖 random;时间走 nowMs 便于测试注入) */
function uid(prefix: string): string {
  idSeq += 1;
  return `${prefix}_${nowMs()}_${idSeq}`;
}

// 单点封装时间获取,测试可 mock
function nowMs(): number {
  return Date.now();
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/* ============ 确定性 id ============ */

/** 物品 id:按规范化名,故重放幂等、手动 op 可稳定引用 */
export function itemId(name: string): string {
  return `item:${norm(name)}`;
}
/** 计划 id:产生它的叶子 id + 在该叶子 add 数组里的序号 */
export function planId(leafId: string, addIndex: number): string {
  return `plan:${leafId}#${addIndex}`;
}

/** 叶子 id:不绑索引、不绑内容,写入即固定 */
export function makeLeafId(): string {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `leaf_${nowMs().toString(36)}_${rand}`;
}

/* ============ 文本清洗 + 陈旧识别 ============ */

/**
 * 清洗楼层正文,供分析模型阅读 / 计算 srcHash:
 *  去思维链 <think>/<thinking>(大小写不敏感)、去标签、规范空白。
 * 摘要喂模型与 hash 用同一清洗,保证「纯排版/标签变化」不误判为内容变更。
 */
export function stripHtml(s: string): string {
  return String(s ?? '')
    .replace(/<think(?:ing)?\b[\s\S]*?<\/think(?:ing)?>/gi, '') // 思维链
    .replace(/<[^>]+>/g, '') // 其余标签
    .replace(/[ \t]+\n/g, '\n') // 行尾空白
    .replace(/\n{3,}/g, '\n\n') // 折叠多余空行
    .trim();
}

/** FNV-1a 32bit → base36,对清洗后的正文敏感 */
export function leafHash(mes: string): string {
  const s = stripHtml(mes);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** 取消息上的叶子(不校验有效性) */
export function getLeaf(m: STMessage | undefined): LeafExtra | undefined {
  return m?.extra?.bbs_leaf as LeafExtra | undefined;
}

/** 叶子是否有效:存在且 srcHash 与当前正文匹配(正文变了即陈旧) */
export function leafValid(m: STMessage | undefined): boolean {
  const leaf = getLeaf(m);
  if (!leaf || !leaf.id || !leaf.delta) return false;
  return leaf.srcHash === leafHash(m!.mes);
}

/* ============ 重放引擎 ============ */

/**
 * 把一条叶子的 StoredDelta 施加到派生记忆 mem 上。无副作用地 fold。
 * 施加顺序(同一叶子内):items(add→update→remove)→ plans(add→resolve→reopen→remove)。
 * 顺序保证「同叶子内先添加后操作」成立(如手动在最新叶子里删掉刚加的项)。
 */
function applyStoredDeltaTo(mem: BaibaiMemory, d: StoredDelta, leaf: { id: string; createdAt: number }): void {
  const t = leaf.createdAt;

  // 覆盖型:空串忽略
  if (typeof d.time === 'string' && d.time.trim()) mem.state.time = d.time.trim();
  if (typeof d.location === 'string' && d.location.trim()) mem.state.location = d.location.trim();

  // 物品
  if (d.items) {
    for (const add of d.items.add ?? []) {
      if (!add?.name?.trim()) continue;
      const id = itemId(add.name);
      const ex = mem.items.find(i => i.id === id);
      if (ex) {
        if (typeof add.qty === 'number') ex.qty = (ex.qty ?? 0) + add.qty;
        if (add.desc) ex.desc = add.desc;
        ex.updatedAt = t;
      } else {
        mem.items.push({
          id,
          name: add.name.trim(),
          desc: add.desc?.trim() || undefined,
          qty: typeof add.qty === 'number' ? add.qty : undefined,
          createdAt: t,
          updatedAt: t,
        });
      }
    }
    for (const upd of d.items.update ?? []) {
      if (!upd?.name?.trim()) continue;
      const it = mem.items.find(i => i.id === itemId(upd.name));
      if (!it) continue; // 容错:更新不存在的项则忽略
      if (typeof upd.qty === 'number') it.qty = upd.qty;
      if (upd.desc) it.desc = upd.desc;
      it.updatedAt = t;
    }
    for (const name of d.items.remove ?? []) {
      if (!name?.trim()) continue;
      const idx = mem.items.findIndex(i => i.id === itemId(name));
      if (idx >= 0) mem.items.splice(idx, 1);
    }
  }

  // 计划 / 悬念
  if (d.plans) {
    (d.plans.add ?? []).forEach((add, addIdx) => {
      if (!add?.content?.trim()) return;
      const id = planId(leaf.id, addIdx);
      if (mem.plans.some(p => p.id === id)) return; // 同叶子重放幂等
      const plan: MemPlan = {
        id,
        kind: add.kind === 'suspense' ? 'suspense' : 'plan',
        content: add.content.trim(),
        status: 'open',
        createdAt: t,
        createdTime: add.createdTime?.trim() || undefined,
        targetTime: add.targetTime?.trim() || undefined,
      };
      mem.plans.push(plan);
    });
    for (const pid of d.plans.resolve ?? []) {
      const p = mem.plans.find(x => x.id === pid);
      if (p) {
        p.status = 'resolved';
        p.resolvedAt = t;
      }
    }
    for (const pid of d.plans.reopen ?? []) {
      const p = mem.plans.find(x => x.id === pid);
      if (p) {
        p.status = 'open';
        p.resolvedAt = undefined;
      }
    }
    for (const pid of d.plans.remove ?? []) {
      const idx = mem.plans.findIndex(x => x.id === pid);
      if (idx >= 0) mem.plans.splice(idx, 1);
    }
  }
}

/**
 * 从 chat 重放出结构化状态。
 * 按**楼层物理顺序**扫 chat,对每条有效叶子 fold 其 delta(楼层序即叙事序,删消息后天然正确)。
 * 压缩节点只压文本、不带 delta、不参与重放。
 * @param upToExclusive 仅重放索引 < 该值的楼层(截断到被分析楼之前;省略=全部)。
 */
export function deriveMemory(
  chat: STMessage[] | null,
  upToExclusive?: number,
): Pick<BaibaiMemory, 'state' | 'items' | 'plans'> {
  const mem = createEmptyMemory();
  if (!chat) return { state: mem.state, items: mem.items, plans: mem.plans };
  const end = typeof upToExclusive === 'number' ? Math.min(upToExclusive, chat.length) : chat.length;
  for (let i = 0; i < end; i++) {
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i])!;
    applyStoredDeltaTo(mem, leaf.delta, { id: leaf.id, createdAt: leaf.createdAt });
  }
  return { state: mem.state, items: mem.items, plans: mem.plans };
}

/* ============ AI delta → 固化 StoredDelta ============ */

/** 解析 "p3" / "3" / "P3" -> 3 */
function parseShortRef(ref: string): number | null {
  const m = String(ref).trim().match(/^p?(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 把 AI 返回的 SummaryDelta 固化成可持久化的 StoredDelta。
 * 关键:plans.resolve 的运行期短序号(p1/p2…)按 openPlansOrdered 翻译成**稳定 plan id**。
 */
export function finalizeDelta(delta: SummaryDelta, openPlansOrdered: { id: string }[]): StoredDelta {
  const out: StoredDelta = {};
  if (typeof delta.time === 'string' && delta.time.trim()) out.time = delta.time.trim();
  if (typeof delta.location === 'string' && delta.location.trim()) out.location = delta.location.trim();

  if (delta.items) {
    const items: NonNullable<StoredDelta['items']> = {};
    if (delta.items.add?.length) items.add = delta.items.add;
    if (delta.items.update?.length) items.update = delta.items.update;
    if (delta.items.remove?.length) items.remove = delta.items.remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (delta.plans) {
    const plans: NonNullable<StoredDelta['plans']> = {};
    if (delta.plans.add?.length) plans.add = delta.plans.add;
    if (delta.plans.resolve?.length) {
      const ids: string[] = [];
      for (const ref of delta.plans.resolve) {
        const n = parseShortRef(ref);
        if (n === null) continue;
        const target = openPlansOrdered[n - 1];
        if (target) ids.push(target.id);
      }
      if (ids.length) plans.resolve = ids;
    }
    if (Object.keys(plans).length) out.plans = plans;
  }
  return out;
}

/* ============ 写入压缩节点(森林) ============ */

/** 追加一条压缩节点(level≥1)。叶子不走这里(在消息 extra 上)。 */
export function addSummary(
  s: Omit<MemSummary, 'id' | 'createdAt'> & Partial<Pick<MemSummary, 'id' | 'createdAt'>>,
): MemSummary {
  const rec: MemSummary = {
    id: s.id ?? uid('sum'),
    text: s.text,
    level: s.level ?? 1,
    createdAt: s.createdAt ?? nowMs(),
    auto: s.auto ?? true,
    timeStart: s.timeStart,
    timeEnd: s.timeEnd,
    timeLabel: s.timeLabel,
    childIds: s.childIds ?? [],
  };
  memory.summaries.push(rec);
  saveMemory();
  return rec;
}

/* ============ 叶子(在消息 extra 上) ============ */

/** 最新一条有效叶子(chat 里最后一条 leafValid 的消息);无则 null */
export function latestLeaf(): { index: number; leaf: LeafExtra } | null {
  const chat = getContext()?.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i--) {
    if (leafValid(chat[i])) return { index: i, leaf: getLeaf(chat[i])! };
  }
  return null;
}

/**
 * 把一段手动 op 合并进「最新有效叶子」的 delta,改内存 extra → 重算 + 落盘(chat 文件)。
 * 无有效叶子时返回 false(页面据此禁用手动添加)。
 * resolve/reopen 互斥去重:对同一 plan,后一次操作覆盖前一次(同叶子内 last-write-wins)。
 * 不改 srcHash(锚定的是正文,不是 delta)→ 不影响 leafValid。
 */
export function appendOpToLatestLeaf(op: StoredDelta): boolean {
  const found = latestLeaf();
  if (!found) return false;
  const { index, leaf } = found;
  const d: StoredDelta = (leaf.delta ??= {});

  if (op.items) {
    const di = (d.items ??= {});
    if (op.items.add?.length) (di.add ??= []).push(...op.items.add);
    if (op.items.update?.length) (di.update ??= []).push(...op.items.update);
    if (op.items.remove?.length) (di.remove ??= []).push(...op.items.remove);
  }
  if (op.plans) {
    const dp = (d.plans ??= {});
    if (op.plans.add?.length) (dp.add ??= []).push(...op.plans.add);
    for (const id of op.plans.resolve ?? []) {
      dp.reopen = (dp.reopen ?? []).filter(x => x !== id); // 互斥
      dp.resolve = [...(dp.resolve ?? []).filter(x => x !== id), id];
    }
    for (const id of op.plans.reopen ?? []) {
      dp.resolve = (dp.resolve ?? []).filter(x => x !== id); // 互斥
      dp.reopen = [...(dp.reopen ?? []).filter(x => x !== id), id];
    }
    for (const id of op.plans.remove ?? []) {
      (dp.remove ??= []).push(id);
    }
  }

  // 重设 extra 引用以确保持久化带上改动
  const chat = getContext()!.chat;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };

  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/** 删除某条消息上的叶子(清 extra),然后级联删坏链 + 重算 + 落盘 */
export function deleteLeafAt(index: number): boolean {
  const chat = getContext()?.chat;
  if (!chat || !chat[index]?.extra?.bbs_leaf) return false;
  delete (chat[index].extra as Record<string, unknown>).bbs_leaf;
  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/**
 * 手动编辑某条消息上的叶子:摘要正文 + 故事内起止时间。
 * 不改 srcHash(锚定的是正文,不是摘要),故叶子仍有效。
 * timeEnd 同步写进 delta.time(覆盖型当前状态,重放即生效);编辑后清掉旧的 timeLabel(已被起止取代)。
 */
export function editLeafAt(index: number, text: string, timeStart: string, timeEnd: string): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf) return false;
  leaf.text = text.trim();
  const s = timeStart.trim();
  const e = timeEnd.trim();
  leaf.timeStart = s || undefined;
  leaf.timeEnd = e || undefined;
  leaf.timeLabel = undefined; // 起止已是权威,旧合并串作废
  leaf.delta = leaf.delta ?? {};
  // 覆盖型当前时间取结束时间;两端皆空才清除
  if (e) leaf.delta.time = e;
  else if (s) leaf.delta.time = s;
  else delete leaf.delta.time;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  recomputeDerived();
  scheduleLeafFlush();
  return true;
}

/**
 * 编辑一条计划/悬念:改 content / createdTime / targetTime。
 * 计划 id = `plan:${叶子id}#${在该叶子 add 数组里的序号}`,据此定位到产生它的叶子的 delta.plans.add[idx]。
 * 不改 srcHash(锚定正文,与 delta 无关),叶子仍有效;改完重算派生 + 落盘。
 */
export function editPlan(
  planIdStr: string,
  patch: { content?: string; createdTime?: string; targetTime?: string },
): boolean {
  const m = planIdStr.match(/^plan:(.+)#(\d+)$/);
  if (!m) return false;
  const leafId = m[1];
  const addIdx = Number(m[2]);
  const chat = getContext()?.chat;
  if (!chat) return false;

  // 找到 id 匹配的有效叶子
  let index = -1;
  for (let i = 0; i < chat.length; i++) {
    const lf = getLeaf(chat[i]);
    if (lf && lf.id === leafId && leafValid(chat[i])) {
      index = i;
      break;
    }
  }
  if (index < 0) return false;
  const leaf = getLeaf(chat[index])!;
  const add = leaf.delta?.plans?.add?.[addIdx];
  if (!add) return false;

  if (typeof patch.content === 'string') add.content = patch.content.trim();
  if (patch.createdTime !== undefined) add.createdTime = patch.createdTime.trim() || undefined;
  if (patch.targetTime !== undefined) add.targetTime = patch.targetTime.trim() || undefined;

  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  recomputeDerived();
  scheduleLeafFlush();
  return true;
}

/**
 * 编辑一个压缩节点(总结)的正文。总结只压文本、不含结构化数据,
 * 故只改 text 字段即可,无需 recompute。
 */
export function editSummary(id: string, text: string): boolean {
  const comp = memory.summaries.find(s => s.id === id);
  if (!comp) return false;
  comp.text = text.trim();
  saveMemory();
  return true;
}

/* ============ 删除 / 拆封 ============ */

/**
 * 删除一个压缩节点。
 *  - 从所有父节点的 childIds 摘除本 id;
 *  - 数组删除本节点。其子节点因父引用断开,自动变回「散装根」。
 * 注意:删压缩节点不影响结构化数据(只压文本),无需 recompute,但要刷新注入。
 */
export function deleteSummary(id: string): boolean {
  const idx = memory.summaries.findIndex(s => s.id === id);
  if (idx < 0) return false;
  for (const p of memory.summaries) {
    if (p.childIds.includes(id)) p.childIds = p.childIds.filter(c => c !== id);
  }
  memory.summaries.splice(idx, 1);
  saveMemory();
  return true;
}

/**
 * 祖先链整删:某叶子 id 不再有效(被删/陈旧/换新 id)时,凡是(递归)包含它的压缩节点全删。
 * 判定:一个压缩节点「完好」⟺ 它的每个 child 要么是现存有效叶子 id、要么是完好的压缩节点;
 * 否则「损坏」,删除。memoized DFS。删除后 saveMemory(若有变化)。
 */
export function pruneBrokenComps(): boolean {
  const chat = getContext()?.chat ?? null;
  const liveLeafIds = new Set<string>();
  if (chat) {
    for (const m of chat) {
      if (leafValid(m)) liveLeafIds.add(getLeaf(m)!.id);
    }
  }
  const byId = new Map(memory.summaries.map(s => [s.id, s]));
  const verdict = new Map<string, boolean>(); // id -> intact

  const isIntact = (id: string, stack: Set<string>): boolean => {
    if (verdict.has(id)) return verdict.get(id)!;
    const comp = byId.get(id);
    if (!comp) return liveLeafIds.has(id); // 不是压缩节点:看是不是现存有效叶子
    if (stack.has(id)) return false; // 防环
    stack.add(id);
    let ok = comp.childIds.length > 0;
    for (const c of comp.childIds) {
      if (!isIntact(c, stack)) {
        ok = false;
        break;
      }
    }
    stack.delete(id);
    verdict.set(id, ok);
    return ok;
  };

  const before = memory.summaries.length;
  memory.summaries = memory.summaries.filter(s => isIntact(s.id, new Set()));
  const changed = memory.summaries.length !== before;
  if (changed) saveMemory();
  return changed;
}

/** 测试辅助:重置 id 序列 */
export function __resetIdSeq(): void {
  idSeq = 0;
}
