import { getContext, type STMessage } from '@/st/context';
import { fmtItemLogInline } from './prompts';
import { memory, recomputeDerived, saveMemory, scheduleLeafFlush } from './store';
import { readItemsTagText, writeItemLogTag } from './timeTag';
import { createEmptyMemory } from './types';
import type { BaibaiMemory, ItemDelta, ItemLogEntry, LeafExtra, MemPlan, MemScene, MemSummary, SceneDelta, SceneReparent, StoredDelta, SummaryDelta } from './types';

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

/** 规范化场景路径:逐段 trim,丢弃空段。返回干净的原文路径(保留大小写,仅去首尾空白) */
export function normScenePath(path: string[] | undefined): string[] {
  if (!Array.isArray(path)) return [];
  return path.map(s => String(s ?? '').trim()).filter(Boolean);
}
/** 场景 id:按规范化路径(小写、'/'分隔),故重放幂等、手动 op 可稳定引用 */
export function sceneId(path: string[]): string {
  return `scene:${normScenePath(path).map(norm).join('/')}`;
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

function applyStoredDeltaTo(mem: BaibaiMemory, d: StoredDelta, leaf: { id: string; createdAt: number; time: string }): void {
  const t = leaf.createdAt;
  const logTime = leaf.time;
  const log = (kind: ItemLogEntry['kind'], name: string, from?: number, to?: number): void => {
    mem.itemLog.push({ name, kind, from, to, time: logTime });
  };

  // 覆盖型:空串忽略
  if (typeof d.time === 'string' && d.time.trim()) mem.state.time = d.time.trim();
  if (typeof d.location === 'string' && d.location.trim()) mem.state.location = d.location.trim();

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
): Pick<BaibaiMemory, 'state' | 'items' | 'plans' | 'scenes' | 'itemLog'> {
  const mem = createEmptyMemory();
  if (!chat) return { state: mem.state, items: mem.items, plans: mem.plans, scenes: mem.scenes, itemLog: mem.itemLog };
  const end = typeof upToExclusive === 'number' ? Math.min(upToExclusive, chat.length) : chat.length;
  for (let i = 0; i < end; i++) {
    if (!leafValid(chat[i])) continue;
    const leaf = getLeaf(chat[i])!;
    // 日志用「故事内时间」:结束时间优先(本段最后时刻),缺则起始,再缺旧 timeLabel,最后空串
    const time = leaf.timeEnd?.trim() || leaf.timeStart?.trim() || leaf.timeLabel?.trim() || '';
    applyStoredDeltaTo(mem, leaf.delta, { id: leaf.id, createdAt: leaf.createdAt, time });
  }
  // 只留最近若干条变动(注入/喂模型够用即可,省 token)
  if (mem.itemLog.length > ITEM_LOG_KEEP) mem.itemLog = mem.itemLog.slice(-ITEM_LOG_KEEP);
  return { state: mem.state, items: mem.items, plans: mem.plans, scenes: mem.scenes, itemLog: mem.itemLog };
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
  const time = leaf.timeEnd?.trim() || leaf.timeStart?.trim() || leaf.timeLabel?.trim() || '';
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
  const canonical = fmtItemLogInline(itemChangesOf(leaf.delta, prior, time));
  chat[index].mes = writeItemLogTag(chat[index].mes, canonical);

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
  if (typeof delta.time === 'string' && delta.time.trim()) out.time = delta.time.trim();
  if (typeof delta.location === 'string' && delta.location.trim()) out.location = delta.location.trim();

  if (delta.items) {
    const items: NonNullable<StoredDelta['items']> = {};
    if (delta.items.add?.length) items.add = delta.items.add;
    if (delta.items.update?.length) items.update = delta.items.update;
    if (delta.items.remove?.length) items.remove = delta.items.remove;
    if (Object.keys(items).length) out.items = items;
  }

  if (delta.scenes) {
    // 规范化路径;「desc 必填」:add/update 缺描述的条目丢弃(写不出描述=不值得记)。
    const clean = (arr?: SceneDelta[]): SceneDelta[] =>
      (arr ?? [])
        .map(s => ({ path: normScenePath(s.path), desc: s.desc?.trim() || undefined }))
        .filter(s => s.path.length && s.desc); // 无 path 或无 desc → 丢弃
    const cleanReparent = (arr?: SceneReparent[]): SceneReparent[] =>
      (arr ?? [])
        .map(r => {
          const node = normScenePath(r.node);
          const newPath = normScenePath(r.newPath);
          const descs: Record<string, string> = {};
          for (const [k, v] of Object.entries(r.descs ?? {})) {
            const key = String(k).trim();
            const val = String(v ?? '').trim();
            if (key && val) descs[key] = val;
          }
          return { node, newPath, descs };
        })
        .filter(r => r.node.length && r.newPath.length);
    const scenes: NonNullable<StoredDelta['scenes']> = {};
    const add = clean(delta.scenes.add);
    const update = clean(delta.scenes.update);
    const reparent = cleanReparent(delta.scenes.reparent);
    if (add.length) scenes.add = add;
    if (update.length) scenes.update = update;
    if (reparent.length) scenes.reparent = reparent;
    if (Object.keys(scenes).length) out.scenes = scenes;
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

/**
 * 手动编辑一个物品(派生数据,写回最新叶子的 delta)。
 *  - 改名:物品 id 按规范化名确定,改名等于换 id → 用 remove(旧名) + add(新名,带 qty/desc) 表达。
 *  - 仅改 qty/desc:用 update(按原名匹配,设为新值)。
 * 两种都经 appendOpToLatestLeaf 落到最新叶子。无有效叶子时返回 false。
 */
export function editItem(
  oldName: string,
  patch: { name?: string; qty?: number; desc?: string },
): boolean {
  const newName = patch.name?.trim() || oldName;
  const desc = patch.desc?.trim() || undefined;
  const qty = typeof patch.qty === 'number' && Number.isFinite(patch.qty) ? patch.qty : undefined;

  if (norm(newName) !== norm(oldName)) {
    // 改名:先删旧,再以新名重建(qty 用 add 语义,但旧的已删,等于设为该值)
    return appendOpToLatestLeaf({
      items: { remove: [oldName], add: [{ name: newName, qty, desc }] },
    });
  }
  // 同名:更新数量/描述(update 是「设为新值」)
  return appendOpToLatestLeaf({ items: { update: [{ name: newName, qty, desc }] } });
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
