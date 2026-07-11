import { apiSettings } from '@/api/settings';
import { getContext, setMessageText, type STMessage } from '@/st/context';
import { fmtItemLogInline } from './prompts';
import { memory, recomputeDerived, saveMemory, scheduleLeafFlush } from './store';
import { readItemsTagText, writeItemLogTag, writeVarLogTag } from './timeTag';
import { createEmptyMemory } from './types';
import type { BaibaiMemory, ItemDelta, ItemLogEntry, JsonValue, LeafExtra, MemNpc, MemPlan, MemScene, MemSummary, NpcDelta, PlanResolveItem, ProtagonistDelta, SceneDelta, SceneReparent, StoredDelta, SummaryDelta, VarOp, VarTemplate, VarTier } from './types';

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function scalarText(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return '';
}

function optText(v: unknown): string | undefined {
  return scalarText(v) || undefined;
}

/** 覆盖补丁文本:undefined=未提供;空字符串=明确清空。 */
function patchText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).trim();
  return undefined;
}

function optBool(v: unknown): boolean | undefined {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
  return undefined;
}

function optNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function namedText(v: unknown, keys: string[] = ['name', 'id', 'content']): string {
  const direct = scalarText(v);
  if (direct) return direct;
  if (!isRecord(v)) return '';
  for (const key of keys) {
    const s = scalarText(v[key]);
    if (s) return s;
  }
  return '';
}

function cleanTextList(v: unknown, keys?: string[]): string[] {
  return arr(v).map(x => namedText(x, keys)).filter(Boolean);
}

function cleanPath(v: unknown): string[] {
  if (Array.isArray(v)) return normScenePath(v);
  const s = scalarText(v);
  return s ? [s] : [];
}

function cleanItemDelta(raw: unknown): ItemDelta | null {
  if (!isRecord(raw)) {
    const name = scalarText(raw);
    return name ? { name } : null;
  }
  const name = namedText(raw, ['name', 'item', 'id']);
  if (!name) return null;
  return {
    name,
    desc: optText(raw.desc),
    qty: optNumber(raw.qty),
    carried: optBool(raw.carried),
    location: optText(raw.location),
  };
}

function cleanItemList(v: unknown): ItemDelta[] {
  return arr(v).map(cleanItemDelta).filter((x): x is ItemDelta => !!x);
}

function cleanSceneDelta(raw: unknown): SceneDelta | null {
  if (!isRecord(raw)) return null;
  const path = cleanPath(raw.path);
  const desc = optText(raw.desc);
  return path.length && desc ? { path, desc } : null;
}

function cleanSceneList(v: unknown): SceneDelta[] {
  return arr(v).map(cleanSceneDelta).filter((x): x is SceneDelta => !!x);
}

function cleanSceneReparent(raw: unknown): SceneReparent | null {
  if (!isRecord(raw)) return null;
  const node = cleanPath(raw.node);
  const newPath = cleanPath(raw.newPath);
  if (!node.length || !newPath.length) return null;
  const descs: Record<string, string> = {};
  if (isRecord(raw.descs)) {
    for (const [k, v] of Object.entries(raw.descs)) {
      const key = scalarText(k);
      const val = optText(v);
      if (key && val) descs[key] = val;
    }
  }
  return { node, newPath, descs };
}

function cleanSceneReparentList(v: unknown): SceneReparent[] {
  return arr(v).map(cleanSceneReparent).filter((x): x is SceneReparent => !!x);
}

function cleanNpcDelta(raw: unknown): NpcDelta | null {
  if (!isRecord(raw)) {
    const name = scalarText(raw);
    return name ? { name } : null;
  }
  const name = namedText(raw, ['name', 'npc', 'id']);
  if (!name) return null;
  return {
    name,
    gender: optText(raw.gender),
    title: optText(raw.title),
    desc: optText(raw.desc),
    personality: optText(raw.personality),
    outfit: optText(raw.outfit),
    condition: optText(raw.condition),
    important: optBool(raw.important),
    follow: optBool(raw.follow),
    location: optText(raw.location),
  };
}

function cleanNpcList(v: unknown): NpcDelta[] {
  return arr(v).map(cleanNpcDelta).filter((x): x is NpcDelta => !!x);
}

function cleanProtagonistDelta(raw: unknown): ProtagonistDelta | null {
  if (!isRecord(raw)) return null;
  const out: ProtagonistDelta = {};
  for (const key of ['gender', 'identity', 'appearance', 'outfit', 'condition'] as const) {
    const value = patchText(raw[key]);
    if (value !== undefined) out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

type PlanAdd = { kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string };

function cleanPlanAdd(raw: unknown): PlanAdd | null {
  if (!isRecord(raw)) {
    const content = scalarText(raw);
    return content ? { kind: 'plan', content } : null;
  }
  const content = namedText(raw, ['content', 'text', 'name']);
  if (!content) return null;
  return {
    kind: raw.kind === 'suspense' ? 'suspense' : 'plan',
    content,
    createdTime: optText(raw.createdTime),
    targetTime: optText(raw.targetTime),
  };
}

function cleanPlanAddList(v: unknown): PlanAdd[] {
  return arr(v).map(cleanPlanAdd).filter((x): x is PlanAdd => !!x);
}

function cleanStoredPlanResolve(raw: unknown): PlanResolveItem | null {
  const id = namedText(raw, ['id', 'planId', 'ref']);
  if (!id) return null;
  if (!isRecord(raw)) return id;
  const out: Exclude<PlanResolveItem, string> = { id };
  if (raw.outcome === 'done' || raw.outcome === 'cancelled' || raw.outcome === 'failed') out.outcome = raw.outcome;
  const reason = optText(raw.reason);
  if (reason) out.reason = reason;
  return out;
}

function cleanStoredPlanResolveList(v: unknown): PlanResolveItem[] {
  return arr(v).map(cleanStoredPlanResolve).filter((x): x is PlanResolveItem => !!x);
}

function cleanStoredDelta(raw: StoredDelta): StoredDelta {
  if (!isRecord(raw)) return {};
  const out: StoredDelta = {};
  const time = optText(raw.time);
  const location = optText(raw.location);
  const locationPath = cleanPath(raw.locationPath);
  if (time) out.time = time;
  if (location) out.location = location;
  if (raw.locationPath !== undefined) out.locationPath = locationPath;
  const protagonist = cleanProtagonistDelta(raw.protagonist);
  if (protagonist) out.protagonist = protagonist;

  if (isRecord(raw.items)) {
    const items: NonNullable<StoredDelta['items']> = {};
    const add = cleanItemList(raw.items.add);
    const update = cleanItemList(raw.items.update);
    const remove = cleanTextList(raw.items.remove, ['name', 'item', 'id']);
    if (add.length) items.add = add;
    if (update.length) items.update = update;
    if (remove.length) items.remove = remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (isRecord(raw.scenes)) {
    const scenes: NonNullable<StoredDelta['scenes']> = {};
    const add = cleanSceneList(raw.scenes.add);
    const update = cleanSceneList(raw.scenes.update);
    const reparent = cleanSceneReparentList(raw.scenes.reparent);
    const remove = arr(raw.scenes.remove).map(cleanPath).filter(p => p.length);
    if (add.length) scenes.add = add;
    if (update.length) scenes.update = update;
    if (reparent.length) scenes.reparent = reparent;
    if (remove.length) scenes.remove = remove;
    if (Object.keys(scenes).length) out.scenes = scenes;
  }

  if (isRecord(raw.npcs)) {
    const npcs: NonNullable<StoredDelta['npcs']> = {};
    const add = cleanNpcList(raw.npcs.add);
    const update = cleanNpcList(raw.npcs.update);
    const remove = cleanTextList(raw.npcs.remove, ['name', 'npc', 'id']);
    if (add.length) npcs.add = add;
    if (update.length) npcs.update = update;
    if (remove.length) npcs.remove = remove;
    if (Object.keys(npcs).length) out.npcs = npcs;
  }

  if (isRecord(raw.plans)) {
    const plans: NonNullable<StoredDelta['plans']> = {};
    const add = cleanPlanAddList(raw.plans.add);
    const resolve = cleanStoredPlanResolveList(raw.plans.resolve);
    const remove = cleanTextList(raw.plans.remove, ['id', 'planId']);
    const reopen = cleanTextList(raw.plans.reopen, ['id', 'planId']);
    if (add.length) plans.add = add;
    if (resolve.length) plans.resolve = resolve;
    if (remove.length) plans.remove = remove;
    if (reopen.length) plans.reopen = reopen;
    if (Object.keys(plans).length) out.plans = plans;
  }

  const varOps = finalizeVarOps(raw.varOps);
  if (varOps.length) out.varOps = varOps;
  return out;
}

/* ============ 确定性 id ============ */

/** 物品 id:按规范化名,故重放幂等、手动 op 可稳定引用 */
export function itemId(name: string): string {
  return `item:${norm(name)}`;
}
/** NPC id:按规范化名,故重放幂等、手动 op 可稳定引用 */
export function npcId(name: string): string {
  return `npc:${norm(name)}`;
}
/** 计划 id:产生它的叶子 id + 在该叶子 add 数组里的序号 */
export function planId(leafId: string, addIndex: number): string {
  return `plan:${leafId}#${addIndex}`;
}

/** 从一条 resolve 指令取稳定 plan id(兼容裸字符串旧数据) */
export function resolveEntryId(r: PlanResolveItem): string {
  return typeof r === 'string' ? r : r.id;
}

/** 规范化场景路径:逐段 trim,丢弃空段。返回干净的原文路径(保留大小写,仅去首尾空白) */
export function normScenePath(path: string[] | undefined): string[] {
  if (!Array.isArray(path)) return [];
  return path.map(s => String(s ?? '').trim()).filter(Boolean);
}
/** 场景 id:按规范化路径(小写、'/'分隔),故重放幂等、手动 op 可稳定引用 */
export function sceneId(path: string[]): string {
  return `scene:${normScenePath(path).map(norm).join('/')}`;
}

/** Index used to resolve item storage text against the scene tree. */
export interface SceneLocationIndex {
  byId: Map<string, MemScene>;
  byParent: Map<string, MemScene[]>;
  byName: Map<string, MemScene[]>;
}

function sceneLocationKey(s: string | undefined): string {
  return (s ?? '').replace(/[\uFE0E\uFE0F]/g, '').trim().toLowerCase();
}

function sortLocationCandidates(arr: MemScene[]): MemScene[] {
  return arr.sort((a, b) =>
    sceneLocationKey(b.name).length - sceneLocationKey(a.name).length
    || b.path.length - a.path.length
    || a.createdAt - b.createdAt,
  );
}

export function buildSceneLocationIndex(scenes: MemScene[]): SceneLocationIndex {
  const byId = new Map<string, MemScene>();
  const byParent = new Map<string, MemScene[]>();
  const byName = new Map<string, MemScene[]>();

  for (const s of scenes) {
    byId.set(s.id, s);

    const siblings = byParent.get(s.parentId) ?? [];
    siblings.push(s);
    byParent.set(s.parentId, siblings);

    const nameKey = sceneLocationKey(s.name);
    if (nameKey) {
      const sameName = byName.get(nameKey) ?? [];
      sameName.push(s);
      byName.set(nameKey, sameName);
    }
  }

  for (const arr of byParent.values()) sortLocationCandidates(arr);
  for (const arr of byName.values()) sortLocationCandidates(arr);
  return { byId, byParent, byName };
}

function sceneNameInLocation(locationKey: string, sceneName: string): boolean {
  const nameKey = sceneLocationKey(sceneName);
  return !!nameKey && locationKey.includes(nameKey);
}

function bestMatchedChild(children: MemScene[], locationKey: string): MemScene | null {
  const hits = children.filter(s => sceneNameInLocation(locationKey, s.name));
  if (!hits.length) return null;
  const bestLen = sceneLocationKey(hits[0].name).length;
  const tied = hits.filter(s => sceneLocationKey(s.name).length === bestLen);
  return tied.length === 1 ? tied[0] : null;
}

/**
 * Resolve a free-form item location into the deepest scene node it names.
 *
 * The walk is deliberately top-down: match a root scene name first, then only
 * inspect that root's children, repeating until no deeper direct child matches.
 * This avoids treating a child location as if it also belonged to every ancestor
 * or sibling whose name appears in the full text.
 */
export function resolveSceneLocationId(
  scenes: MemScene[],
  location: string | undefined,
  index: SceneLocationIndex = buildSceneLocationIndex(scenes),
): string {
  const locationKey = sceneLocationKey(location);
  if (!locationKey || !scenes.length) return '';

  let cur = bestMatchedChild(index.byParent.get('') ?? [], locationKey);
  if (cur) {
    for (;;) {
      const next = bestMatchedChild(index.byParent.get(cur.id) ?? [], locationKey);
      if (!next) break;
      cur = next;
    }
    return cur.id;
  }

  const candidates: MemScene[] = [];
  for (const list of index.byName.values()) {
    for (const s of list) {
      if (sceneNameInLocation(locationKey, s.name)) candidates.push(s);
    }
  }
  sortLocationCandidates(candidates);
  if (!candidates.length) return '';
  const bestLen = sceneLocationKey(candidates[0].name).length;
  const tied = candidates.filter(s => sceneLocationKey(s.name).length === bestLen);
  return tied.length === 1 ? tied[0].id : '';
}

function scenePathStartsWith(path: string[], prefix: string[]): boolean {
  return prefix.length > 0
    && prefix.length <= path.length
    && prefix.every((seg, i) => norm(seg) === norm(path[i]));
}

export function itemReachableAtScene(
  scenes: MemScene[],
  itemLoc: string | undefined,
  current: MemScene | null,
  here = '',
  index: SceneLocationIndex = buildSceneLocationIndex(scenes),
): boolean {
  if (!current) return sceneNameReachable(itemLoc, here);
  const itemSceneId = resolveSceneLocationId(scenes, itemLoc, index);
  const itemScene = itemSceneId ? index.byId.get(itemSceneId) : null;
  if (!itemScene) return false;
  return scenePathStartsWith(current.path, itemScene.path);
}

/**
 * 当前地点 ↔ 场景树的「权威定位」:返回当前所在节点 id(找不到返回 '')。
 * 注入端与场景页**共用此函数**,杜绝两处分叉导致页面/提示词不一致。
 */
export function findCurrentSceneId(scenes: MemScene[], here: string, locationPath?: string[]): string {
  const byId = new Map(scenes.map(s => [s.id, s]));

  // 1) 权威路径:精确 → 最长存在前缀
  const lp = normScenePath(locationPath);
  if (lp.length) {
    for (let depth = lp.length; depth >= 1; depth--) {
      const id = sceneId(lp.slice(0, depth));
      if (byId.has(id)) return id;
    }
  }

  // 2) 收紧模糊匹配(兜底):只看本级名 + 完整路径串,取最深
  const h = (here ?? '').trim();
  if (!h) return '';
  let best: MemScene | null = null;
  for (const s of scenes) {
    const hit = sceneNameReachable(s.name, h) || sceneNameReachable(s.path.join(''), h);
    if (hit && (!best || s.path.length > best.path.length)) best = s;
  }
  return best?.id ?? '';
}

/**
 * 两个场景节点路径的相对关系,以 pPath(主角当前节点)为基准。供 NPC 在场分档用:
 *  - 'same':同一节点。
 *  - 'near':N 是 P 的直接父(上一级)/ N 是 P 的后代(向下不封顶)/ 旁支且共享直接父。
 *  - 'far' :N 是 P 更上级祖先(≥2 级)/ 旁支且公共祖先更远。
 * 「同区域」= near:抬头最多一级就能找到与主角共同的地点(向上封顶一级,挡住街区/城镇;向下不封顶)。
 */
export type SceneRel = 'same' | 'near' | 'far';
export function sceneRelation(pPath: string[], nPath: string[]): SceneRel {
  let common = 0;
  const min = Math.min(pPath.length, nPath.length);
  while (common < min && norm(pPath[common]) === norm(nPath[common])) common++;
  const p = pPath.length;
  const q = nPath.length;
  if (common === p && common === q) return 'same';       // 同一节点
  if (common === q) return p - q === 1 ? 'near' : 'far';  // N 是 P 的祖先:仅上一级算近
  if (common === p) return 'near';                        // N 是 P 的后代:向下不封顶
  return p - common === 1 ? 'near' : 'far';               // 旁支:共享直接父才算近
}

export type NpcPresence = 'present' | 'nearby' | 'absent';

/**
 * NPC 在场分档的**唯一权威**:注入端(inject.ts)与 NPC 页(pages/npcs)都调它,杜绝两套逻辑漂移
 * (NPC 页曾复刻旧逻辑、又没用 locationPath,把主角误定位到同名旁支节点、错判在场——正是本函数要根治的)。
 *  - 'present':随行,或所在地=主角当前节点(含解析并入当前节点的更细子地点)。
 *  - 'nearby' :抬头最多一级就与主角共处(上一级祖先 / 后代 / 旁支共享直接父)。
 *  - 'absent' :更上级祖先(街区/校区)或更远旁支。
 * 主角/NPC 任一落不到树节点时退回纯字符串双向包含(present/absent 两态)。
 */
export function classifyNpcPresence(
  npc: MemNpc,
  scenes: MemScene[],
  here: string,
  locationPath?: string[],
): NpcPresence {
  if (npc.follow === true) return 'present';
  // 主角当前节点:走权威 findCurrentSceneId(优先 locationPath 精确定位,再模糊兜底)
  const cur = scenes.find(s => s.id === findCurrentSceneId(scenes, here, locationPath)) ?? null;
  if (!cur) return sceneNameReachable(npc.location, here) ? 'present' : 'absent';
  // NPC 所在地同样解析成节点后比路径
  const n = scenes.find(s => s.id === findCurrentSceneId(scenes, npc.location ?? '')) ?? null;
  if (!n) return sceneNameReachable(npc.location, here) ? 'present' : 'absent';
  const rel = sceneRelation(cur.path, n.path);
  return rel === 'same' ? 'present' : rel === 'near' ? 'nearby' : 'absent';
}

/** 包含式双向匹配(地名命名粗细不一时的兜底);空串不匹配。供 findCurrentSceneId 内部用。 */
function sceneNameReachable(a: string | undefined, b: string): boolean {
  const x = (a ?? '').trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

/** 叶子 id:不绑索引、不绑内容,写入即固定 */
export function makeLeafId(): string {
  const rand = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0');
  return `leaf_${nowMs().toString(36)}_${rand}`;
}

/* ============ 陈旧识别 ============ */

// 正文清洗已统一到 timeTag.ts 的 cleanBody / clampToTimeTags(整块删噪声标签,不再「裸删标签留内容」)。

/** 取消息上的叶子(不校验有效性) */
export function getLeaf(m: STMessage | undefined): LeafExtra | undefined {
  return m?.extra?.bbs_leaf as LeafExtra | undefined;
}

/** 叶子结构是否完整(有 id + delta)。不校验页码归属;供 pruneBrokenComps 判「叶子是否物理存在」。 */
export function leafIntact(m: STMessage | undefined): boolean {
  const leaf = getLeaf(m);
  return !!(leaf && leaf.id && leaf.delta);
}

/**
 * 把一个稳定 plan id(plan:${leafId}#${addIdx})反查成计划内容文本。
 * resolve/reopen/remove 只存 id、不存文本;楼内面板要显示「了结:找到妹妹」需据此回查产生它的叶子。
 * 找不到(叶子已删/id 非法)返回空串,调用方自行降级。
 */
export function planContentById(planIdStr: string): string {
  const m = planIdStr.match(/^plan:(.+)#(\d+)$/);
  if (!m) return '';
  const leafId = m[1];
  const addIdx = Number(m[2]);
  const chat = getContext()?.chat;
  if (!chat) return '';
  for (let i = 0; i < chat.length; i++) {
    const lf = getLeaf(chat[i]);
    if (lf?.id === leafId) return scalarText(lf.delta?.plans?.add?.[addIdx]?.content);
  }
  return '';
}

/** 叶子记录的页码(缺省按第一页 0);消息当前页码同口径(swipe_id 缺省 0)。 */
function leafSwipe(leaf: LeafExtra): number {
  return typeof leaf.swipe === 'number' ? leaf.swipe : 0;
}
function msgSwipe(m: STMessage): number {
  return typeof m.swipe_id === 'number' ? m.swipe_id : 0;
}

/**
 * 叶子是否对「当前显示的这一页」有效:结构完整 + 页码归属当前 swipe。
 *
 * 页码校验解决多页串扰:ST 生成新 swipe 时 structuredClone 旧 extra,会把上一页的 bbs_leaf
 * 复制进新页;靠「叶子 swipe ≠ 当前 swipe_id」识别并失效——翻到没摘过的页正确显示「缺摘要」,
 * 翻回原页页码又匹配、摘要恢复。叶子数据始终留在各自 swipe 的 extra 里,不删除。
 *
 * ⚠️ 不比对正文哈希:改正文(错字/润色)不改 swipe_id,故不会因此失效——这正是用页码而非
 * srcHash 的好处。代价同前:编辑正文不自动重摘,沿用旧叶子;需要时手动删叶子再重摘。
 */
export function leafValid(m: STMessage | undefined): boolean {
  const leaf = getLeaf(m);
  if (!leaf || !leaf.id || !leaf.delta) return false;
  if (!m) return false;
  return leafSwipe(leaf) === msgSwipe(m);
}

/* ============ 重放引擎 ============ */

/**
 * 把一条叶子的 StoredDelta 施加到派生记忆 mem 上。无副作用地 fold。
 * 施加顺序(同一叶子内):items(add→update→remove)→ plans(add→resolve→reopen→remove)。
 * 顺序保证「同叶子内先添加后操作」成立(如手动在最新叶子里删掉刚加的项)。
 *
 * 副作用:每条物品变动往 mem.itemLog 追加一条带「故事内时间」的记录(leaf.time)。
 * 按楼层序重放,故 itemLog 天然时序有序;deriveMemory 末尾再截最近若干条。
 */
/**
 * 把 delta 里的随身/地点信息施加到物品上(仅在 delta 明确给了才覆盖,last-write-wins)。
 * carried=true 时清掉 location(随身物品无存放地);carried=false 时保留/采用 location。
 */
function applyPlacement(it: { carried?: boolean; location?: string }, src: ItemDelta): void {
  if (typeof src.carried === 'boolean') {
    it.carried = src.carried;
    if (src.carried) it.location = undefined; // 拿在身上 → 无存放地
  }
  if (typeof src.location === 'string') {
    const loc = src.location.trim();
    if (loc) {
      it.location = loc;
      if (it.carried === undefined) it.carried = false; // 给了地点即视为非随身
    }
  }
}

/**
 * 把 delta 里的随行/所在地信息施加到 NPC 上(仅在 delta 明确给了才覆盖,last-write-wins)。
 * follow=true 时清掉 location(随行 NPC 无固定所在地);follow=false 时保留/采用 location。
 * 与物品 applyPlacement 同构(carried↔follow)。
 */
function applyNpcPlacement(n: { follow?: boolean; location?: string }, src: NpcDelta): void {
  if (typeof src.follow === 'boolean') {
    n.follow = src.follow;
    if (src.follow) n.location = undefined; // 随行 → 无固定所在地
  }
  if (typeof src.location === 'string') {
    const loc = src.location.trim();
    if (loc) {
      n.location = loc;
      if (n.follow === undefined) n.follow = false; // 给了所在地即视为定点
    }
  }
}

/**
 * 把 delta 里的「即时层」状态(outfit/condition)与 important 施加到 NPC 上。
 * 与档案层(desc/title)不同:即时层一旦 delta 给了就**直接覆盖**(它本就是当前快照,
 * 不像 desc 那样「实质变化才动」);add 与 update 同样处理,确保换装/受伤能即时刷新。
 */
function applyNpcState(n: { outfit?: string; condition?: string; important?: boolean }, src: NpcDelta): void {
  if (typeof src.outfit === 'string') n.outfit = src.outfit.trim() || undefined;
  if (typeof src.condition === 'string') n.condition = src.condition.trim() || undefined;
  if (typeof src.important === 'boolean') n.important = src.important || undefined;
}

/** 主角档案是纯覆盖快照;空字符串表示清除旧值。 */
function applyProtagonistState(target: BaibaiMemory['protagonist'], src: ProtagonistDelta): void {
  for (const key of ['gender', 'identity', 'appearance', 'outfit', 'condition'] as const) {
    if (typeof src[key] === 'string') target[key] = src[key]!.trim() || undefined;
  }
}

/**
 * 逐级 upsert 一条场景路径到派生场景树。
 * 遍历 path 的每个前缀确保每级节点存在(缺则创建,父 id 由上一级前缀算出);
 * 仅**最末级**节点采用 desc(setDesc 为真=update 覆盖;否则 add 仅在原本无描述时补)。
 * 父子关系由确定性 id 隐式成立,无需 childIds。
 */
function upsertScenePath(mem: BaibaiMemory, path: string[], desc: string | undefined, setDesc: boolean, t: number): void {
  const clean = normScenePath(path);
  if (!clean.length) return;
  for (let depth = 1; depth <= clean.length; depth++) {
    const prefix = clean.slice(0, depth);
    const id = sceneId(prefix);
    const parentId = depth > 1 ? sceneId(clean.slice(0, depth - 1)) : '';
    const isLeafLevel = depth === clean.length;
    const node = mem.scenes.find(s => s.id === id);
    if (!node) {
      mem.scenes.push({
        id,
        name: prefix[prefix.length - 1],
        path: prefix,
        parentId,
        desc: isLeafLevel ? desc?.trim() || undefined : undefined,
        createdAt: t,
        updatedAt: t,
      });
    } else if (isLeafLevel && desc?.trim()) {
      if (setDesc || !node.desc) node.desc = desc.trim(); // update 覆盖;add 仅补空
      node.updatedAt = t;
    }
  }
}

/** 移除一条场景路径及其所有后代(按 id 前缀匹配) */
function removeScenePath(mem: BaibaiMemory, path: string[]): void {
  const clean = normScenePath(path);
  if (!clean.length) return;
  const id = sceneId(clean);
  const childPrefix = `${id}/`; // 后代的 id 形如 `${id}/子级…`
  mem.scenes = mem.scenes.filter(s => s.id !== id && !s.id.startsWith(childPrefix));
}

/**
 * 重设父级:把 node(及其整棵子树)平移到 newPath。覆盖「加父 / 插中间节点 / 换父」三情形。
 *  - 先沿 newPath 的祖先逐级补建父级(带 descs 描述);
 *  - 再把 node 子树每个节点的 path/id/parentId 整体由 旧前缀 改写成 新前缀。
 * 防御:① node 不存在则跳过(可能已被前面的楼移过,幂等);
 *       ② newPath 穿过 node 自身(把父挂到自己子树下)会成环 → 跳过,保护树结构。
 */
function reparentScenePath(mem: BaibaiMemory, r: SceneReparent, t: number): void {
  const from = normScenePath(r.node);
  const to = normScenePath(r.newPath);
  if (!from.length || !to.length) return;
  const fromId = sceneId(from);
  const node = mem.scenes.find(s => s.id === fromId);
  if (!node) return; // 幂等:目标节点不存在

  const newId = sceneId(to);
  if (newId === fromId) return; // 原地不动
  // 环检测:新路径不能落在被移动子树之内(newId 等于 fromId 或以 fromId/ 为前缀)
  if (newId.startsWith(`${fromId}/`)) return;

  // 补建 newPath 上「除末段外」的祖先层级(末段即 node 自身,稍后由平移产生)
  for (let depth = 1; depth < to.length; depth++) {
    const prefix = to.slice(0, depth);
    const id = sceneId(prefix);
    if (mem.scenes.some(s => s.id === id)) continue;
    const segName = prefix[prefix.length - 1];
    mem.scenes.push({
      id,
      name: segName,
      path: prefix,
      parentId: depth > 1 ? sceneId(to.slice(0, depth - 1)) : '',
      desc: r.descs?.[segName]?.trim() || undefined,
      createdAt: t,
      updatedAt: t,
    });
  }

  // 平移子树:旧前缀 fromId → 新前缀 newId,旧路径 from → 新路径 to
  const childPrefix = `${fromId}/`;
  const newParentId = to.length > 1 ? sceneId(to.slice(0, to.length - 1)) : '';
  const newName = to[to.length - 1];
  for (const s of mem.scenes) {
    if (s.id === fromId) {
      s.id = newId;
      s.path = [...to];
      s.name = newName;
      s.parentId = newParentId;
      // descs 若给了该节点新名的描述,顺带更新(支持「改父同时改描述」);否则保留原描述
      const d = r.descs?.[newName]?.trim();
      if (d) s.desc = d;
      s.updatedAt = t;
    } else if (s.id.startsWith(childPrefix)) {
      // 后代:把路径前 from.length 段替换成 to,其余保留
      const tail = s.path.slice(from.length);
      s.path = [...to, ...tail];
      s.id = sceneId(s.path);
      s.parentId = sceneId(s.path.slice(0, s.path.length - 1));
      s.updatedAt = t;
    }
  }
}

/* ============ 自定义变量:JSON 树 + 路径命令(仿 MVU) ============ */

function isPlainObj(v: unknown): v is Record<string, JsonValue> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷 JSON 值(避免多处共享引用被就地改)。 */
export function deepCloneJson<T extends JsonValue>(v: T): T {
  if (Array.isArray(v)) return v.map(x => deepCloneJson(x)) as T;
  if (isPlainObj(v)) {
    const o: Record<string, JsonValue> = {};
    for (const k of Object.keys(v)) o[k] = deepCloneJson(v[k]);
    return o as T;
  }
  return v;
}

/** 深合并:b 覆盖 a(仅对象递归;数组/标量整体取 b)。 */
function deepMerge(a: Record<string, JsonValue>, b: Record<string, JsonValue>): Record<string, JsonValue> {
  const out = deepCloneJson(a);
  for (const k of Object.keys(b)) {
    const bv = b[k];
    if (isPlainObj(bv) && isPlainObj(out[k])) out[k] = deepMerge(out[k] as Record<string, JsonValue>, bv);
    else out[k] = deepCloneJson(bv);
  }
  return out;
}

/** 合并三层模板成初始状态:global < char < chat(精确层覆盖)。 */
export function mergeTemplates(t: Record<VarTier, VarTemplate>): Record<string, JsonValue> {
  return deepMerge(deepMerge(deepCloneJson(t.global.json), t.char.json), t.chat.json);
}

/**
 * 在**重放起点(seed)**展开变量模板里的 ST 宏({{user}}/{{char}}/… 全套,走 substituteParams)。
 * 深走整棵 JSON:对象的**键**与所有**字符串值**都替换;数字/布尔/null 原样。
 *
 * 为何只在 seed 展开(而非注入时):宏只可能来自用户填的模板;AI 与手动命令产出的永远是真实值。
 * 故把「字面模板」在合并成初始状态的那一刻替换成真实名,之后 fold 各楼 VarOps 全程真实名、
 * 天然对齐——无需把 AI 输出的真实名反向映射回 {{user}}(那会因同名/群聊/改名而脆)。
 * 模板本身仍存字面宏(saveMemory 只存模板,mem.vars 是派生缓存不落盘),故全局变量跨角色可移植:
 * 切角色后重新 seed 即得新角色名。ST 未就绪 / 无 substituteParams 时原样返回(降级不炸)。
 */
export function expandVarMacros(json: Record<string, JsonValue>): Record<string, JsonValue> {
  const sub = getContext()?.substituteParams;
  if (typeof sub !== 'function') return json; // 降级:拿不到宏展开就用字面值
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return sub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObj(v)) {
      const out: Record<string, JsonValue> = {};
      for (const k of Object.keys(v)) out[sub(k)] = walk(v[k]); // 键也展开
      return out;
    }
    return v;
  };
  return walk(json) as Record<string, JsonValue>;
}

/** 解析路径成段:"势力.魔法议会[0].声望" → ['势力','魔法议会',0,'声望'];''→[]。 */
function parsePath(path: string): (string | number)[] {
  const segs: (string | number)[] = [];
  for (const part of String(path ?? '').split('.')) {
    if (part === '') continue;
    const m = part.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) { segs.push(part); continue; }
    if (m[1]) segs.push(m[1]);
    const idxs = m[2].match(/\d+/g);
    if (idxs) for (const i of idxs) segs.push(Number(i));
  }
  return segs;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function getChild(parent: any, key: string | number): any {
  return Array.isArray(parent) ? parent[Number(key)] : parent[String(key)];
}
function setChild(parent: any, key: string | number, value: JsonValue): void {
  if (Array.isArray(parent)) parent[Number(key)] = value;
  else parent[String(key)] = value;
}
function removeChild(parent: any, key: string | number): void {
  if (Array.isArray(parent)) parent.splice(Number(key), 1);
  else delete parent[String(key)];
}

/** 定位 path 的父容器与末段键;create=true 自动创建缺失中间层(下一段是数字→数组,否则对象)。 */
function locate(root: Record<string, JsonValue>, segs: (string | number)[], create: boolean): { parent: any; last: string | number } | null {
  let cur: any = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur == null || typeof cur !== 'object') return null;
    if (getChild(cur, s) === undefined || getChild(cur, s) === null) {
      if (!create) return null;
      setChild(cur, s, typeof segs[i + 1] === 'number' ? [] : {});
    }
    cur = getChild(cur, s);
  }
  if (cur == null || typeof cur !== 'object') return null;
  return { parent: cur, last: segs[segs.length - 1] };
}

/** 施加一条路径命令到 JSON 根(就地改)。坏命令由调用方 try/catch 兜住。 */
function applyVarOp(root: Record<string, JsonValue>, op: VarOp): void {
  const segs = parsePath(op.path);

  // 根(path=''):set 用 value 整体替换根内容;assign/remove 按 key 操作根对象
  if (segs.length === 0) {
    if (op.op === 'set' && isPlainObj(op.value)) {
      for (const k of Object.keys(root)) delete root[k];
      Object.assign(root, deepCloneJson(op.value));
    } else if (op.op === 'assign' && op.key !== undefined) {
      root[String(op.key)] = deepCloneJson(op.value ?? null);
    } else if (op.op === 'remove' && op.key !== undefined) {
      delete root[String(op.key)];
    }
    return;
  }

  const create = op.op === 'set' || op.op === 'assign' || op.op === 'add';
  const loc = locate(root, segs, create);
  if (!loc) return;
  const { parent, last } = loc;

  switch (op.op) {
    case 'set':
      setChild(parent, last, deepCloneJson(op.value ?? null));
      break;
    case 'add': {
      const cur = getChild(parent, last);
      const d = typeof op.delta === 'number' ? op.delta : 0;
      setChild(parent, last, (typeof cur === 'number' ? cur : 0) + d);
      break;
    }
    case 'assign': {
      let container = getChild(parent, last);
      if (op.key !== undefined) {
        if (container == null || typeof container !== 'object') { container = typeof op.key === 'number' ? [] : {}; setChild(parent, last, container); }
        setChild(container, op.key, deepCloneJson(op.value ?? null));
      } else {
        if (!Array.isArray(container)) { container = []; setChild(parent, last, container); }
        (container as JsonValue[]).push(deepCloneJson(op.value ?? null));
      }
      break;
    }
    case 'remove': {
      const container = getChild(parent, last);
      if (op.key === undefined) {
        removeChild(parent, last); // 删 path 本身
      } else if (Array.isArray(container)) {
        if (typeof op.key === 'number') container.splice(op.key, 1);
        else { const i = container.findIndex(x => x === op.key); if (i >= 0) container.splice(i, 1); }
      } else if (isPlainObj(container)) {
        delete container[String(op.key)];
      }
      break;
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** 依序施加一批命令;单条坏命令跳过不致命。 */
export function applyVarOps(root: Record<string, JsonValue>, ops: VarOp[] | undefined): void {
  if (!ops?.length) return;
  for (const op of ops) {
    try { applyVarOp(root, op); } catch { /* 坏命令跳过 */ }
  }
}

/** 变量值 → 紧凑单行串(对象/数组 JSON 化;折叠换行;超长截断)。供旁注/面板展示。 */
function fmtVarValue(v: JsonValue | undefined): string {
  if (v === undefined) return '';
  let s: string;
  if (typeof v === 'string') s = v;
  else { try { s = JSON.stringify(v); } catch { s = String(v); } }
  s = s.replace(/\s*[\r\n]+\s*/g, ' ').trim();
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

/**
 * 把一条变量命令描述成可读的「主文本 + 副文本」——楼层正文旁注与楼内面板**共用同一来源**,
 * 保证两处措辞一致。主文本=被改的路径(assign/remove 带 key 时拼到尾),副文本=值/增量。
 */
export function describeVarOp(op: VarOp): { text: string; sub?: string } {
  const path = op.path || '(根)';
  switch (op.op) {
    case 'set':
      return { text: path, sub: `设为 ${fmtVarValue(op.value)}` };
    case 'add': {
      const d = typeof op.delta === 'number' ? op.delta : 0;
      return { text: path, sub: `${d >= 0 ? '+' : ''}${d}` };
    }
    case 'assign': {
      const key = op.key !== undefined ? String(op.key) : '';
      const full = key ? (op.path ? `${op.path}.${key}` : key) : `${path}[追加]`;
      return { text: full, sub: `= ${fmtVarValue(op.value)}` };
    }
    case 'remove': {
      const key = op.key !== undefined ? String(op.key) : '';
      return { text: key ? (op.path ? `${op.path}.${key}` : key) : path };
    }
    default:
      return { text: path };
  }
}

/**
 * 把本楼变量命令渲染成 <bbs_vars> 旁注的多行文本(每行一条,带动词前缀)。
 * 与 fmtItemLogInline 同角色:让窗口内全文楼层的主模型看到「本楼已改过这些变量」,防重复改。
 * 空则返回空串(调用方据此不写块)。
 */
export function fmtVarOpsInline(ops: VarOp[] | undefined): string {
  if (!ops?.length) return '';
  const verb: Record<VarOp['op'], string> = { set: '设定', add: '变更', assign: '新增', remove: '删除' };
  return ops
    .map(op => {
      const { text, sub } = describeVarOp(op);
      return sub ? `${verb[op.op]} ${text} ${sub}` : `${verb[op.op]} ${text}`;
    })
    .join('\n');
}

/** 校验 AI 返回的命令数组 → 干净的 VarOp[](丢弃非法 op)。 */
export function finalizeVarOps(raw: unknown): VarOp[] {
  if (!Array.isArray(raw)) return [];
  const out: VarOp[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const op = o.op;
    if (op !== 'set' && op !== 'assign' && op !== 'remove' && op !== 'add') continue;
    const vo: VarOp = { op, path: typeof o.path === 'string' ? o.path : '' };
    if (typeof o.key === 'string' || typeof o.key === 'number') vo.key = o.key;
    if ('value' in o) vo.value = o.value as JsonValue;
    if (op === 'add') vo.delta = Number(o.delta) || 0;
    out.push(vo);
  }
  return out;
}

function applyStoredDeltaTo(mem: BaibaiMemory, d: StoredDelta, leaf: { id: string; createdAt: number; time: string }): void {
  const t = leaf.createdAt;
  const logTime = leaf.time;
  const log = (kind: ItemLogEntry['kind'], name: string, from?: number, to?: number): void => {
    mem.itemLog.push({ name, kind, from, to, time: logTime });
  };
  d = cleanStoredDelta(d);

  // 覆盖型:空串忽略
  if (typeof d.time === 'string' && d.time.trim()) mem.state.time = d.time.trim();
  if (typeof d.location === 'string' && d.location.trim()) {
    mem.state.location = d.location.trim();
    // location 一变,locationPath 跟随同一条 delta:AI 给了就采用,没给则清空(避免 path 比 location 旧)
    const lp = normScenePath(d.locationPath);
    mem.state.locationPath = lp.length ? lp : undefined;
  } else if (d.locationPath !== undefined) {
    // 少见:只更新 path 不动 location(手动场景);采用或清空
    const lp = normScenePath(d.locationPath);
    mem.state.locationPath = lp.length ? lp : undefined;
  }
  if (d.protagonist) applyProtagonistState(mem.protagonist, d.protagonist);

  // 物品(一切计数:add 默认 +1,带符号累加,数量 ≤0 自动移除)
  if (d.items) {
    for (const add of d.items.add ?? []) {
      if (!add?.name?.trim()) continue;
      const id = itemId(add.name);
      const ex = mem.items.find(i => i.id === id);
      const step = typeof add.qty === 'number' ? add.qty : 1; // 缺数量默认 1
      if (ex) {
        const before = ex.qty;
        const next = (ex.qty ?? 1) + step; // 原不计数旧数据按 1 起算
        if (add.desc) ex.desc = add.desc;
        applyPlacement(ex, add); // 随身/地点(明确给了才覆盖)
        if (next <= 0) {
          mem.items.splice(mem.items.indexOf(ex), 1); // 减到 0 → 移除
          log('remove', ex.name, before, 0);
        } else {
          ex.qty = next;
          ex.updatedAt = t;
          log('add', ex.name, before, next);
        }
      } else if (step > 0) {
        const it: BaibaiMemory['items'][number] = {
          id,
          name: add.name.trim(),
          desc: add.desc?.trim() || undefined,
          qty: step,
          createdAt: t,
          updatedAt: t,
        };
        applyPlacement(it, add);
        mem.items.push(it);
        log('add', add.name.trim(), undefined, step);
      }
      // step ≤0 且物品不存在:无可减,忽略
    }
    for (const upd of d.items.update ?? []) {
      if (!upd?.name?.trim()) continue;
      const it = mem.items.find(i => i.id === itemId(upd.name));
      if (!it) continue; // 容错:更新不存在的项则忽略
      const before = it.qty;
      if (upd.desc) it.desc = upd.desc;
      applyPlacement(it, upd); // 随身/地点变更(移动物品)
      if (typeof upd.qty === 'number') {
        if (upd.qty <= 0) {
          mem.items.splice(mem.items.indexOf(it), 1); // 设为 ≤0 → 移除
          log('remove', it.name, before, 0);
          continue;
        }
        it.qty = upd.qty;
      }
      it.updatedAt = t;
      log('update', it.name, before, it.qty);
    }
    for (const name of d.items.remove ?? []) {
      if (!name?.trim()) continue;
      const idx = mem.items.findIndex(i => i.id === itemId(name));
      if (idx >= 0) {
        const [removed] = mem.items.splice(idx, 1);
        log('remove', removed.name, removed.qty, 0);
      }
    }
  }

  // 场景 / 地点。施加序:add → update → reparent → remove
  // (reparent 在 add 之后,保证被引用节点已存在;remove 最后,避免移动刚被删的节点)。
  if (d.scenes) {
    for (const a of d.scenes.add ?? []) upsertScenePath(mem, a.path, a.desc, false, t);
    for (const u of d.scenes.update ?? []) upsertScenePath(mem, u.path, u.desc, true, t);
    for (const r of d.scenes.reparent ?? []) reparentScenePath(mem, r, t);
    for (const p of d.scenes.remove ?? []) removeScenePath(mem, p);
  }

  // NPC(指令型:add 新登场 / update 改身份位置 / remove 退场)。施加序:add → update → remove。
  // update 对不存在的名字按 upsert 创建,兼容迁移后名册为空、但后续摘要误产 update 的历史数据。
  if (d.npcs) {
    for (const add of d.npcs.add ?? []) {
      if (!add?.name?.trim()) continue;
      const id = npcId(add.name);
      const ex = mem.npcs.find(n => n.id === id);
      if (ex) {
        // 已存在:档案层(gender/title/desc/性格)add 视作补全(仅填空,不覆盖既有);
        // 即时层(outfit/condition/important)仍直接覆盖(它本就是当前快照),再施加位置。
        if (add.gender && !ex.gender) ex.gender = add.gender.trim();
        if (add.title && !ex.title) ex.title = add.title.trim();
        if (add.desc && !ex.desc) ex.desc = add.desc.trim();
        if (add.personality && !ex.personality) ex.personality = add.personality.trim();
        applyNpcState(ex, add);
        applyNpcPlacement(ex, add);
        ex.updatedAt = t;
      } else {
        const npc: BaibaiMemory['npcs'][number] = {
          id,
          name: add.name.trim(),
          gender: add.gender?.trim() || undefined,
          title: add.title?.trim() || undefined,
          desc: add.desc?.trim() || undefined,
          personality: add.personality?.trim() || undefined,
          createdAt: t,
          updatedAt: t,
        };
        applyNpcState(npc, add);
        applyNpcPlacement(npc, add);
        mem.npcs.push(npc);
      }
    }
    for (const upd of d.npcs.update ?? []) {
      if (!upd?.name?.trim()) continue;
      const id = npcId(upd.name);
      let n = mem.npcs.find(x => x.id === id);
      if (!n) {
        n = {
          id,
          name: upd.name.trim(),
          gender: upd.gender?.trim() || undefined,
          title: upd.title?.trim() || undefined,
          desc: upd.desc?.trim() || undefined,
          personality: upd.personality?.trim() || undefined,
          createdAt: t,
          updatedAt: t,
        };
        mem.npcs.push(n);
      }
      if (upd.gender) n.gender = upd.gender.trim();
      if (upd.title) n.title = upd.title.trim();
      if (upd.desc) n.desc = upd.desc.trim();
      if (upd.personality) n.personality = upd.personality.trim();
      applyNpcState(n, upd); // 即时层(着装/状态/重要性)覆盖刷新
      applyNpcPlacement(n, upd); // 随行/所在地变更(NPC 移动)
      n.updatedAt = t;
    }
    for (const name of d.npcs.remove ?? []) {
      if (!name?.trim()) continue;
      const idx = mem.npcs.findIndex(x => x.id === npcId(name));
      if (idx >= 0) mem.npcs.splice(idx, 1);
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
    for (const r of d.plans.resolve ?? []) {
      const p = mem.plans.find(x => x.id === resolveEntryId(r));
      if (p) {
        p.status = 'resolved';
        p.resolvedAt = t;
        // 携带「怎么了结/为什么」;裸字符串旧数据无此信息,保持不写
        if (typeof r !== 'string') {
          p.outcome = r.outcome;
          p.resolvedReason = r.reason?.trim() || undefined;
        }
      }
    }
    for (const pid of d.plans.reopen ?? []) {
      const p = mem.plans.find(x => x.id === pid);
      if (p) {
        p.status = 'open';
        p.resolvedAt = undefined;
        p.outcome = undefined; // 重开 → 清掉上次了结的结论
        p.resolvedReason = undefined;
      }
    }
    for (const pid of d.plans.remove ?? []) {
      const idx = mem.plans.findIndex(x => x.id === pid);
      if (idx >= 0) mem.plans.splice(idx, 1);
    }
  }

  // 自定义变量:按顺序把本楼路径命令施加到 JSON 状态
  if (d.varOps?.length) applyVarOps(mem.vars, d.varOps);
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
): Pick<BaibaiMemory, 'state' | 'protagonist' | 'items' | 'plans' | 'scenes' | 'npcs' | 'itemLog' | 'vars'> {
  const mem = createEmptyMemory();
  // 变量从三层合并模板起算(无 chat 也返回初始状态);seed 时展开模板里的 ST 宏({{user}} 等)
  mem.vars = expandVarMacros(mergeTemplates(memory.varTemplates));
  if (!chat) return { state: mem.state, protagonist: mem.protagonist, items: mem.items, plans: mem.plans, scenes: mem.scenes, npcs: mem.npcs, itemLog: mem.itemLog, vars: mem.vars };
  const end = typeof upToExclusive === 'number' ? Math.min(upToExclusive, chat.length) : chat.length;
  for (let i = 0; i < end; i++) {
    if (chat[i]?.extra?.bbs_omit) continue; // 番外楼:不参与派生重放
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i])!;
    // 日志用「故事内时间」:结束时间优先(本段最后时刻),缺则起始,再缺旧 timeLabel,最后空串
    const time = optText(leaf.timeEnd) || optText(leaf.timeStart) || optText(leaf.timeLabel) || '';
    applyStoredDeltaTo(mem, leaf.delta, { id: leaf.id, createdAt: leaf.createdAt, time });
  }
  // 只留最近若干条变动(注入/喂模型够用即可,省 token)
  if (mem.itemLog.length > ITEM_LOG_KEEP) mem.itemLog = mem.itemLog.slice(-ITEM_LOG_KEEP);
  return { state: mem.state, protagonist: mem.protagonist, items: mem.items, plans: mem.plans, scenes: mem.scenes, npcs: mem.npcs, itemLog: mem.itemLog, vars: mem.vars };
}

/** 变动日志保留的最近条数(注入与喂摘要共用)。 */
export const ITEM_LOG_KEEP = 8;

/**
 * 算「单条 delta 相对给定先前物品状态」产生的物品变动条目(供写进该楼正文)。
 * 复用 applyStoredDeltaTo:用先前物品播种一个临时 mem,只施加这一条 delta,
 * 捕获其 itemLog 即本楼净变动(带 from→to)。time 由调用方传入(本楼故事结束时间)。
 */
export function itemChangesOf(
  delta: StoredDelta,
  priorItems: BaibaiMemory['items'],
  time: string,
): ItemLogEntry[] {
  const mem = createEmptyMemory();
  // 深拷贝先前物品作起点(避免污染调用方);只关心 items,plans/state 不影响 itemLog
  mem.items = priorItems.map(i => ({ ...i }));
  applyStoredDeltaTo(mem, { items: delta.items }, { id: 'tmp', createdAt: 0, time });
  return mem.itemLog;
}

/* ============ <bbs_items> 旁注 ↔ delta 反向同步(用户改正文) ============ */

/**
 * 解析 <bbs_items> 块的「动词式」多行文本 → 带符号物品增量。
 * 每行:`<动词> <名字> [数量]`。动词:获得=+,消耗/失去=-。缺数量默认 1。
 * 名字可含空格(取动词后、末尾可选数字前的全部);非法行忽略。
 * 返回 add 形式(qty 带符号,复用 applyStoredDeltaTo 的带符号累加 + ≤0 移除语义)。
 */
export function parseItemLogText(text: string): { name: string; qty: number }[] {
  const out: { name: string; qty: number }[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(获得|消耗|失去)\s+(.+?)(?:\s+(\d+))?$/);
    if (!m) continue;
    const sign = m[1] === '获得' ? 1 : -1;
    const name = m[2].trim();
    if (!name) continue;
    const n = m[3] ? Number(m[3]) : 1;
    if (!Number.isFinite(n) || n <= 0) continue;
    out.push({ name, qty: sign * n });
  }
  return out;
}

/**
 * 用户编辑了某楼正文后,把其中 <bbs_items> 旁注的改动反向同步回该楼叶子的 delta.items。
 *
 * 一致性判定走「同一渲染管线」:把叶子现有 delta 渲染成规范旁注,与正文里的旁注比对;
 * 相等 → 用户没动物品(只改了别处正文)→ 跳过,不碰 delta、不重写正文(避免误改/抖动)。
 * 不等 → 以正文为准:解析成带符号 add,**替换**该叶子 delta 的 items 部分(time/location/plans 保留),
 *        重算派生、删坏链,并把正文旁注重写成规范格式(顺手清掉用户的非规范写法),最后落盘。
 *
 * 注:旁注不承载描述/数量绝对值,反解析按「增量」表达;故用户改旁注会丢失原 delta 里的 desc(可接受,
 * 描述请走物品列表编辑)。无 <bbs_items> 块(用户删了整块)→ 视作清空该楼物品变动。
 * 返回是否发生了改写。
 */
export function syncItemLogFromMessage(index: number): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf || !leaf.delta) return false;

  // 该楼之前的物品状态(用于把 delta 渲染成与正文同口径的旁注做比对)
  const prior = deriveMemory(chat, index).items;
  const time = optText(leaf.timeEnd) || optText(leaf.timeStart) || optText(leaf.timeLabel) || '';
  const currentInline = fmtItemLogInline(itemChangesOf(leaf.delta, prior, time));

  const tagText = readItemsTagText(chat[index].mes); // null = 无块
  const editedInline = tagText === null ? '' : fmtItemLogInline(parsedToLog(parseItemLogText(tagText), prior));

  if (currentInline === editedInline) return false; // 物品旁注未变,跳过

  // 以正文为准:解析成带符号 add,替换 delta 的 items 部分。
  // 旁注不承载随身/地点,按物品名从旧 delta 的 add/update 里继承回来,避免改数量误清空间信息。
  const placeBefore = new Map<string, { carried?: boolean; location?: string }>();
  for (const e of [...(leaf.delta.items?.add ?? []), ...(leaf.delta.items?.update ?? [])]) {
    if (e.carried !== undefined || e.location !== undefined) {
      placeBefore.set(itemId(e.name), { carried: e.carried, location: e.location });
    }
  }
  const parsed = parseItemLogText(tagText ?? '');
  if (parsed.length) {
    leaf.delta.items = {
      add: parsed.map(p => {
        const place = placeBefore.get(itemId(p.name));
        return { name: p.name, qty: p.qty, ...(place ?? {}) };
      }),
    };
  } else delete leaf.delta.items;

  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };

  // 正文旁注重写成规范格式(用规范化后的 delta 重新渲染)
  if (!apiSettings.summaryOnlyMode) {
    const canonical = fmtItemLogInline(itemChangesOf(leaf.delta, prior, time));
    setMessageText(chat[index], writeItemLogTag(chat[index].mes, canonical));
  }

  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/** 把解析出的带符号增量套用到先前状态,得到 ItemLogEntry[](供渲染比对,与 itemChangesOf 同口径)。 */
function parsedToLog(parsed: { name: string; qty: number }[], prior: BaibaiMemory['items']): ItemLogEntry[] {
  if (!parsed.length) return [];
  return itemChangesOf({ items: { add: parsed.map(p => ({ name: p.name, qty: p.qty })) } }, prior, '');
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
  const time = optText(delta.time);
  const location = optText(delta.location);
  if (time) out.time = time;
  if (location) out.location = location;
  // 权威定位路径:规范化后非空才固化(只有给了 location 才有意义,但不强制——手动场景可单独给)
  const lp = cleanPath(delta.locationPath);
  if (lp.length) out.locationPath = lp;
  const protagonist = cleanProtagonistDelta(delta.protagonist);
  if (protagonist) out.protagonist = protagonist;

  if (isRecord(delta.items)) {
    const items: NonNullable<StoredDelta['items']> = {};
    const add = cleanItemList(delta.items.add);
    const update = cleanItemList(delta.items.update);
    const remove = cleanTextList(delta.items.remove, ['name', 'item', 'id']);
    if (add.length) items.add = add;
    if (update.length) items.update = update;
    if (remove.length) items.remove = remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (isRecord(delta.scenes)) {
    // 规范化路径;「desc 必填」:add/update 缺描述的条目丢弃(写不出描述=不值得记)。
    const scenes: NonNullable<StoredDelta['scenes']> = {};
    const add = cleanSceneList(delta.scenes.add);
    const update = cleanSceneList(delta.scenes.update);
    const reparent = cleanSceneReparentList(delta.scenes.reparent);
    if (add.length) scenes.add = add;
    if (update.length) scenes.update = update;
    if (reparent.length) scenes.reparent = reparent;
    if (Object.keys(scenes).length) out.scenes = scenes;
  }

  if (isRecord(delta.npcs)) {
    // 规范化:add/update 必须有名字才保留(无名 NPC 不记)
    const npcs: NonNullable<StoredDelta['npcs']> = {};
    const add = cleanNpcList(delta.npcs.add);
    const update = cleanNpcList(delta.npcs.update);
    const remove = cleanTextList(delta.npcs.remove, ['name', 'npc', 'id']);
    if (add.length) npcs.add = add;
    if (update.length) npcs.update = update;
    if (remove.length) npcs.remove = remove;
    if (Object.keys(npcs).length) out.npcs = npcs;
  }

  if (isRecord(delta.plans)) {
    const plans: NonNullable<StoredDelta['plans']> = {};
    const add = cleanPlanAddList(delta.plans.add);
    if (add.length) plans.add = add;
    if (arr(delta.plans.resolve).length) {
      const out: PlanResolveItem[] = [];
      for (const ref of arr(delta.plans.resolve)) {
        // 短序号可能是裸字符串 "p2" 或带结局的对象 { id:"p2", outcome, reason }
        const shortRef = namedText(ref, ['id', 'ref', 'planId']);
        const n = parseShortRef(shortRef);
        if (n === null) continue;
        const target = openPlansOrdered[n - 1];
        if (!target) continue;
        if (!isRecord(ref)) {
          out.push(target.id); // 旧格式:只翻译成稳定 id
        } else {
          const entry: PlanResolveItem = { id: target.id };
          if (ref.outcome === 'done' || ref.outcome === 'cancelled' || ref.outcome === 'failed') entry.outcome = ref.outcome;
          const reason = optText(ref.reason);
          if (reason) entry.reason = reason;
          out.push(entry);
        }
      }
      if (out.length) plans.resolve = out;
    }
    if (Object.keys(plans).length) out.plans = plans;
  }

  if (Array.isArray(delta.vars) && delta.vars.length) {
    const ops = finalizeVarOps(delta.vars);
    if (ops.length) out.varOps = ops;
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

  if (op.protagonist) {
    d.protagonist = { ...(d.protagonist ?? {}), ...op.protagonist };
  }
  if (op.items) {
    // 关键:同名物品在 add/update 与 remove 之间必须互斥(跨桶抵消),否则改名(remove旧+add新)
    // 往返会让 remove 桶残留旧名,而重放固定按 add→update→remove 分组——最后的 remove 会把刚
    // add 回来的同名物品删掉(物品离奇消失)。add 桶内仍保留 push 累加,不动「手动+1」语义。
    const di = (d.items ??= {});
    for (const name of op.items.remove ?? []) {
      const id = itemId(name);
      // 删除压倒本叶子内对该名的 add/update;再登记待删(去重,prior 叶子的该物品靠它删除)
      if (di.add) di.add = di.add.filter(a => itemId(a.name) !== id);
      if (di.update) di.update = di.update.filter(u => itemId(u.name) !== id);
      di.remove = [...(di.remove ?? []).filter(n => itemId(n) !== id), name];
    }
    for (const a of op.items.add ?? []) {
      if (di.remove) di.remove = di.remove.filter(n => itemId(n) !== itemId(a.name)); // 撤销同名待删
      (di.add ??= []).push(a);
    }
    for (const u of op.items.update ?? []) {
      if (di.remove) di.remove = di.remove.filter(n => itemId(n) !== itemId(u.name));
      (di.update ??= []).push(u);
    }
    if (di.add && !di.add.length) delete di.add;
    if (di.update && !di.update.length) delete di.update;
    if (di.remove && !di.remove.length) delete di.remove;
  }
  if (op.npcs) {
    // 与物品同款跨桶互斥:同名 NPC 在 add/update 与 remove 之间不能并存,
    // 否则改名(remove旧+add新)往返会让 remove 桶残留旧名,重放按 add→update→remove 把刚 add 的删掉。
    const dn = (d.npcs ??= {});
    for (const name of op.npcs.remove ?? []) {
      const id = npcId(name);
      if (dn.add) dn.add = dn.add.filter(a => npcId(a.name) !== id);
      if (dn.update) dn.update = dn.update.filter(u => npcId(u.name) !== id);
      dn.remove = [...(dn.remove ?? []).filter(n => npcId(n) !== id), name];
    }
    for (const a of op.npcs.add ?? []) {
      if (dn.remove) dn.remove = dn.remove.filter(n => npcId(n) !== npcId(a.name));
      (dn.add ??= []).push(a);
    }
    for (const u of op.npcs.update ?? []) {
      if (dn.remove) dn.remove = dn.remove.filter(n => npcId(n) !== npcId(u.name));
      (dn.update ??= []).push(u);
    }
    if (dn.add && !dn.add.length) delete dn.add;
    if (dn.update && !dn.update.length) delete dn.update;
    if (dn.remove && !dn.remove.length) delete dn.remove;
  }
  if (op.scenes) {
    const ds = (d.scenes ??= {});
    if (op.scenes.add?.length) (ds.add ??= []).push(...op.scenes.add);
    if (op.scenes.update?.length) (ds.update ??= []).push(...op.scenes.update);
    if (op.scenes.reparent?.length) (ds.reparent ??= []).push(...op.scenes.reparent);
    if (op.scenes.remove?.length) (ds.remove ??= []).push(...op.scenes.remove);
  }
  if (op.plans) {
    const dp = (d.plans ??= {});
    if (op.plans.add?.length) (dp.add ??= []).push(...op.plans.add);
    for (const r of op.plans.resolve ?? []) {
      const rid = resolveEntryId(r);
      dp.reopen = (dp.reopen ?? []).filter(x => x !== rid); // 互斥
      dp.resolve = [...(dp.resolve ?? []).filter(x => resolveEntryId(x) !== rid), r];
    }
    for (const id of op.plans.reopen ?? []) {
      dp.resolve = (dp.resolve ?? []).filter(x => resolveEntryId(x) !== id); // 互斥
      dp.reopen = [...(dp.reopen ?? []).filter(x => x !== id), id];
    }
    for (const id of op.plans.remove ?? []) {
      (dp.remove ??= []).push(id);
    }
  }
  if (op.varOps?.length) {
    // 追加本次命令到最新叶子(按顺序,后施加者覆盖前者)
    (d.varOps ??= []).push(...op.varOps);
  }

  // 重设 extra 引用以确保持久化带上改动
  const chat = getContext()!.chat;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };

  recomputeDerived();
  pruneBrokenComps();
  scheduleLeafFlush();
  return true;
}

/**
 * 手动把整棵变量状态设为 newJson(派生数据,写回最新叶子的一条根 set 命令)。
 * 供变量页「编辑当前值(JSON)」用:用户直接编辑整份 JSON,存成 set('', newJson)。
 * 无有效叶子返回 false。
 */
export function setVarsRoot(newJson: Record<string, JsonValue>): boolean {
  return appendOpToLatestLeaf({ varOps: [{ op: 'set', path: '', value: newJson }] });
}

/** 手动覆盖主角当前档案。空字符串会清除对应旧值。 */
export function setProtagonist(patch: ProtagonistDelta): boolean {
  const clean = cleanProtagonistDelta(patch);
  return clean ? appendOpToLatestLeaf({ protagonist: clean }) : false;
}

/**
 * 手动编辑一个物品(派生数据,写回最新叶子的 delta)。
 *  - 改名:物品 id 按规范化名确定,改名等于换 id → 用 remove(旧名) + add(新名,带 qty/desc/位置) 表达。
 *  - 仅改 qty/desc/位置:用 update(按原名匹配,设为新值)。
 * 两种都经 appendOpToLatestLeaf 落到最新叶子。无有效叶子时返回 false。
 *
 * 位置(carried/location):patch 未显式给时,改名场景从派生的旧物品继承——否则改个名字
 * 就把「在武器库」这类存放信息丢了(用 add 重建会丢非 add 字段)。
 */
export function editItem(
  oldName: string,
  patch: { name?: string; qty?: number; desc?: string; carried?: boolean; location?: string },
): boolean {
  const newName = patch.name?.trim() || oldName;
  const desc = patch.desc?.trim() || undefined;
  const qty = typeof patch.qty === 'number' && Number.isFinite(patch.qty) ? patch.qty : undefined;

  // 位置:patch 明确给了用 patch 的;否则从旧物品继承(改名不丢存放地)
  const prev = memory.items.find(i => i.id === itemId(oldName));
  const carried = patch.carried !== undefined ? patch.carried : prev?.carried;
  const location = patch.location !== undefined ? (patch.location.trim() || undefined) : prev?.location;

  if (norm(newName) !== norm(oldName)) {
    // 改名:删旧名 + 以新名重建。
    // add 是「累加」语义,只有当新名在所有叶子里都不存在时才等于「设为该值」;
    // 但改名往返(A→B→A)时,A 往往在更早的叶子里已被 add 过,remove 只作用于本次删的旧名,
    // 拦不住早期叶子对 A 的累加 —— 会把数量叠上去(3 改回后变 4)。
    // 故再补一条 update:重放序 add→update,add 先建身份/描述/位置(哪怕误累加),
    // update 把数量「设为绝对值」,与物品源自哪条叶子无关。qty 未给(留空=不计数)时不发 update。
    return appendOpToLatestLeaf({
      items: {
        remove: [oldName],
        add: [{ name: newName, qty, desc, carried, location }],
        ...(qty !== undefined ? { update: [{ name: newName, qty }] } : {}),
      },
    });
  }
  // 同名:更新数量/描述/位置(update 是「设为新值」)
  return appendOpToLatestLeaf({ items: { update: [{ name: newName, qty, desc, carried, location }] } });
}

/* ============ NPC 手动 op(写回最新叶子,与 editItem 同范式) ============ */

/** 手动新增一个 NPC。无有效叶子返回 false。 */
export function upsertNpc(
  fields: {
    name: string;
    gender?: string;
    title?: string;
    desc?: string;
    personality?: string;
    outfit?: string;
    condition?: string;
    important?: boolean;
    follow?: boolean;
    location?: string;
  },
): boolean {
  const name = fields.name.trim();
  if (!name) return false;
  return appendOpToLatestLeaf({
    npcs: {
      add: [{
        name,
        gender: fields.gender?.trim() || undefined,
        title: fields.title?.trim() || undefined,
        desc: fields.desc?.trim() || undefined,
        personality: fields.personality?.trim() || undefined,
        outfit: fields.outfit?.trim() || undefined,
        condition: fields.condition?.trim() || undefined,
        important: fields.important,
        follow: fields.follow,
        location: fields.location?.trim() || undefined,
      }],
    },
  });
}

/**
 * 手动编辑一个 NPC(派生数据,写回最新叶子的 delta),与 editItem 同范式。
 *  - 改名:NPC id 按规范化名确定,改名等于换 id → remove(旧名) + add(新名,带全字段)。
 *  - 仅改字段:update(按原名匹配,设为新值)。
 * 随行/所在地(follow/location):patch 未显式给时,改名场景从派生的旧 NPC 继承(改名不丢位置)。
 * 无有效叶子返回 false。
 */
export function editNpc(
  oldName: string,
  patch: {
    name?: string;
    gender?: string;
    title?: string;
    desc?: string;
    personality?: string;
    outfit?: string;
    condition?: string;
    important?: boolean;
    follow?: boolean;
    location?: string;
  },
): boolean {
  const newName = patch.name?.trim() || oldName;
  const gender = patch.gender?.trim() || undefined;
  const title = patch.title?.trim() || undefined;
  const desc = patch.desc?.trim() || undefined;
  const personality = patch.personality?.trim() || undefined;

  // 位置 / 即时层:patch 明确给了用 patch 的;否则从旧 NPC 继承(改名不丢所在地/随行/状态/重要性)
  const prev = memory.npcs.find(n => n.id === npcId(oldName));
  const follow = patch.follow !== undefined ? patch.follow : prev?.follow;
  const location = patch.location !== undefined ? (patch.location.trim() || undefined) : prev?.location;
  const outfit = patch.outfit !== undefined ? (patch.outfit.trim() || undefined) : prev?.outfit;
  const condition = patch.condition !== undefined ? (patch.condition.trim() || undefined) : prev?.condition;
  const important = patch.important !== undefined ? patch.important : prev?.important;

  const fields = { gender, title, desc, personality, outfit, condition, important, follow, location };
  if (norm(newName) !== norm(oldName)) {
    return appendOpToLatestLeaf({
      npcs: { remove: [oldName], add: [{ name: newName, ...fields }] },
    });
  }
  return appendOpToLatestLeaf({ npcs: { update: [{ name: newName, ...fields }] } });
}

/**
 * 切换某 NPC 的随行状态(同伴/取消同伴)。
 *  - follow=true:标记随行(applyNpcPlacement 会清掉 location)。
 *  - follow=false:取消随行;可选传入 location 指定「留在哪」,不传则保留原所在地。
 */
export function setNpcFollow(name: string, follow: boolean, location?: string): boolean {
  const nm = name.trim();
  if (!nm) return false;
  const loc = follow ? undefined : (location?.trim() || undefined);
  return appendOpToLatestLeaf({ npcs: { update: [{ name: nm, follow, location: loc }] } });
}

/** 切换某 NPC 的「主要角色」标记(升/降重要性);与 setNpcFollow 同范式,写回最新叶子。 */
export function setNpcImportant(name: string, important: boolean): boolean {
  const nm = name.trim();
  if (!nm) return false;
  return appendOpToLatestLeaf({ npcs: { update: [{ name: nm, important }] } });
}

/** 手动删除一个 NPC(退场)。 */
export function removeNpc(name: string): boolean {
  const nm = name.trim();
  if (!nm) return false;
  return appendOpToLatestLeaf({ npcs: { remove: [nm] } });
}

/* ============ 场景手动 op(写回最新叶子,与 editItem 同范式) ============ */

/** 手动新增/补全一个地点(逐级地理路径)。无有效叶子返回 false。 */
export function upsertScene(path: string[], desc?: string): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { add: [{ path: clean, desc: desc?.trim() || undefined }] } });
}

/** 手动更新一个地点的描述(覆盖)。 */
export function editSceneDesc(path: string[], desc: string): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { update: [{ path: clean, desc: desc.trim() || undefined }] } });
}

/**
 * 改某地点的名字(连子树一起改)。改名 = 同父下换末段名 = reparent 的一个情形:
 * newPath 保留原上级、只换末段,reparentScenePath 会把整棵子树平移到新名下,子节点不丢失。
 * 名字没变则只更新描述(若给了)。
 */
export function renameScene(oldPath: string[], newName: string, desc?: string): boolean {
  const clean = normScenePath(oldPath);
  const nm = newName.trim();
  if (!clean.length || !nm) return false;
  if (norm(nm) === norm(clean[clean.length - 1])) {
    return desc !== undefined ? editSceneDesc(clean, desc) : false; // 名没变,只改描述
  }
  const newPath = [...clean.slice(0, -1), nm];
  const descs = desc?.trim() ? { [nm]: desc.trim() } : undefined;
  return appendOpToLatestLeaf({ scenes: { reparent: [{ node: clean, newPath, descs }] } });
}

/**
 * 手动重设父级 / 改名 / 插层(连子树平移),用一条 reparent 表达。
 *  - newPath:目标完整路径(末段可与原名不同 = 顺带改名;前缀即新上级,空前缀=顶级)。
 *  - descs:newPath 上各级的描述(键=该级地名),用于补建父级 + 更新被移动节点自身的描述。
 * 复用与 AI 同一套 reparent 重放逻辑。
 */
export function reparentScene(nodePath: string[], newPath: string[], descs?: Record<string, string>): boolean {
  const node = normScenePath(nodePath);
  const to = normScenePath(newPath);
  if (!node.length || !to.length) return false;
  if (sceneId(to) === sceneId(node)) return false; // 路径没变
  return appendOpToLatestLeaf({ scenes: { reparent: [{ node, newPath: to, descs }] } });
}

/** 手动删除一个地点(连带其后代)。 */
export function removeScene(path: string[]): boolean {
  const clean = normScenePath(path);
  if (!clean.length) return false;
  return appendOpToLatestLeaf({ scenes: { remove: [clean] } });
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
 * 楼内面板专用:整体编辑某楼叶子(摘要正文 + 起止时间 + 结构化 delta)。
 * 与 editLeafAt 的区别:连 delta 一起替换,一次重放。供楼内面板「改关键字段 / 删条目」用。
 * delta 由调用方在克隆上改好后整体传入(只改现有条目值 / 删条目,不涉及跨桶抵消逻辑,故直接替换即可)。
 * 时间处理与 editLeafAt 一致:timeEnd(缺则 timeStart)覆盖写进 delta.time;两端皆空则清除。
 */
export function editLeafFull(
  index: number,
  patch: { text: string; timeStart: string; timeEnd: string; delta: StoredDelta },
): boolean {
  const chat = getContext()?.chat;
  const leaf = getLeaf(chat?.[index]);
  if (!chat || !leaf) return false;
  leaf.text = patch.text.trim();
  const s = patch.timeStart.trim();
  const e = patch.timeEnd.trim();
  leaf.timeStart = s || undefined;
  leaf.timeEnd = e || undefined;
  leaf.timeLabel = undefined; // 起止已是权威,旧合并串作废
  const delta: StoredDelta = { ...patch.delta };
  // 覆盖型当前时间取结束时间;两端皆空才清除(与 editLeafAt 同口径)
  if (e) delta.time = e;
  else if (s) delta.time = s;
  else delete delta.time;
  leaf.delta = delta;
  chat[index].extra = { ...(chat[index].extra ?? {}), bbs_leaf: leaf };
  // 编辑改了 delta → 同步重写该楼正文的 <bbs_items>/<bbs_vars> 旁注(否则旁注停留在上次摘要的旧值),
  // 与 applyLeafForFloor 落叶时同口径:物品净变动以「本楼之前状态」为基准算 from→to,变量直接渲染命令。
  rewriteFloorTags(chat, index, delta);
  recomputeDerived();
  scheduleLeafFlush();
  return true;
}

/**
 * 用叶子当前 delta 重写该楼正文的 <bbs_items>/<bbs_vars> 旁注(供楼内编辑后同步正文)。
 * 基准物品状态 = 本楼之前(deriveMemory 到 index,不含本楼),与摘要落叶时一致。
 */
function rewriteFloorTags(chat: STMessage[], index: number, delta: StoredDelta): void {
  if (apiSettings.summaryOnlyMode) return;

  const leaf = getLeaf(chat[index]);
  const time = optText(leaf?.timeEnd) || optText(leaf?.timeStart) || '';
  const priorItems = deriveMemory(chat, index).items;
  let mes = writeItemLogTag(chat[index].mes, fmtItemLogInline(itemChangesOf(delta, priorItems, time)));
  mes = writeVarLogTag(mes, fmtVarOpsInline(delta.varOps));
  setMessageText(chat[index], mes);
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
 * 删除递归包含某个子节点的全部祖先压缩节点。
 *
 * 叶子重新生成时会保留原 id,因此 pruneBrokenComps 无法识别上层总结文本已经过时。
 * 这里从 childId 向上找父节点并移除整条祖先链;未被任何总结收纳的叶子不会造成改动。
 */
export function invalidateSummaryAncestors(childId: string): number {
  if (!childId) return 0;
  const affected = new Set<string>([childId]);
  let found = true;
  while (found) {
    found = false;
    for (const summary of memory.summaries) {
      if (affected.has(summary.id)) continue;
      if (summary.childIds.some(id => affected.has(id))) {
        affected.add(summary.id);
        found = true;
      }
    }
  }

  const before = memory.summaries.length;
  memory.summaries = memory.summaries.filter(summary => !affected.has(summary.id));
  const removed = before - memory.summaries.length;
  if (removed > 0) saveMemory();
  return removed;
}

/**
 * 祖先链整删:某叶子 id 不再有效(被删/陈旧/换新 id)时,凡是(递归)包含它的压缩节点全删。
 * 判定:一个压缩节点「完好」⟺ 它的每个 child 要么是现存有效叶子 id、要么是完好的压缩节点;
 * 否则「损坏」,删除。memoized DFS。删除后 saveMemory(若有变化)。
 *
 * ⚠️ 这里用 leafIntact 而非 leafValid:叶子「存活」只看物理存在(id+delta),**不看页码归属**。
 * 翻页到没摘过的 swipe 时,被压缩进 L1 的叶子虽对当前页 leafValid=false,但它仍物理存在于
 * 自己那一页的 extra 里(翻回去就显示)——绝不能因「当前不在这页」就删掉它所属的压缩链。
 */
export function pruneBrokenComps(): boolean {
  const chat = getContext()?.chat ?? null;
  const liveLeafIds = new Set<string>();
  if (chat) {
    for (const m of chat) {
      if (leafIntact(m)) liveLeafIds.add(getLeaf(m)!.id);
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
