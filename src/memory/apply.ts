import { memory, saveMemory } from './store';
import type { BaibaiMemory, MemPlan, MemSummary, SummaryDelta } from './types';

let idSeq = 0;
/** 生成稳定唯一 id(不依赖 Date.now/random 以便测试可复现时可注入) */
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

/**
 * 把 AI 返回的增量施加到记忆。
 * 覆盖型(time/location):直接写新值(空串忽略)。
 * 指令型(items/plans):按指令增删改,容错处理不存在/重复。
 */
export function applyDelta(delta: SummaryDelta, sourceId?: string): void {
  applyState(delta);
  applyItems(delta, sourceId);
  applyPlans(delta, sourceId);
  saveMemory();
}

function applyState(delta: SummaryDelta) {
  if (typeof delta.time === 'string' && delta.time.trim()) {
    memory.state.time = delta.time.trim();
  }
  if (typeof delta.location === 'string' && delta.location.trim()) {
    memory.state.location = delta.location.trim();
  }
}

function applyItems(delta: SummaryDelta, sourceId?: string) {
  const ops = delta.items;
  if (!ops) return;
  const t = nowMs();

  for (const add of ops.add ?? []) {
    if (!add?.name?.trim()) continue;
    const existing = memory.items.find(i => norm(i.name) === norm(add.name));
    if (existing) {
      // 已存在则累加数量 / 更新描述,避免重复条目
      if (typeof add.qty === 'number') existing.qty = (existing.qty ?? 0) + add.qty;
      if (add.desc) existing.desc = add.desc;
      existing.updatedAt = t;
    } else {
      memory.items.push({
        id: uid('item'),
        name: add.name.trim(),
        desc: add.desc?.trim() || undefined,
        qty: typeof add.qty === 'number' ? add.qty : undefined,
        createdAt: t,
        updatedAt: t,
        sourceId,
      });
    }
  }

  for (const upd of ops.update ?? []) {
    if (!upd?.name?.trim()) continue;
    const it = memory.items.find(i => norm(i.name) === norm(upd.name));
    if (!it) continue; // 容错:更新不存在的项则忽略
    if (typeof upd.qty === 'number') it.qty = upd.qty;
    if (upd.desc) it.desc = upd.desc;
    it.updatedAt = t;
  }

  for (const name of ops.remove ?? []) {
    if (!name?.trim()) continue;
    const idx = memory.items.findIndex(i => norm(i.name) === norm(name));
    if (idx >= 0) memory.items.splice(idx, 1); // 容错:不存在则无操作
  }
}

function applyPlans(delta: SummaryDelta, sourceId?: string) {
  const ops = delta.plans;
  if (!ops) return;
  const t = nowMs();

  for (const add of ops.add ?? []) {
    if (!add?.content?.trim()) continue;
    // 去重:同 kind 同内容不重复加
    const dup = memory.plans.find(p => p.kind === add.kind && norm(p.content) === norm(add.content) && p.status === 'open');
    if (dup) continue;
    const plan: MemPlan = {
      id: uid('plan'),
      kind: add.kind === 'suspense' ? 'suspense' : 'plan',
      content: add.content.trim(),
      status: 'open',
      createdAt: t,
      sourceId,
    };
    memory.plans.push(plan);
  }

  // resolve 用提示词里展示的短序号(p1/p2…)定位 open 计划
  if (ops.resolve?.length) {
    const openPlans = memory.plans.filter(p => p.status === 'open');
    for (const ref of ops.resolve) {
      const n = parseShortRef(ref);
      if (n === null) continue;
      const target = openPlans[n - 1];
      if (target) {
        target.status = 'resolved';
        target.resolvedAt = t;
      }
    }
  }
}

/** 解析 "p3" / "3" / "P3" -> 3 */
function parseShortRef(ref: string): number | null {
  const m = String(ref).trim().match(/^p?(\d+)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 追加一条摘要记录 */
export function addSummary(s: Omit<MemSummary, 'id' | 'createdAt'> & Partial<Pick<MemSummary, 'id' | 'createdAt'>>): MemSummary {
  const rec: MemSummary = {
    id: s.id ?? uid('sum'),
    text: s.text,
    coveredIndices: s.coveredIndices ?? [],
    depth: s.depth ?? 1,
    createdAt: s.createdAt ?? nowMs(),
    auto: s.auto ?? true,
    mergedFrom: s.mergedFrom,
    timeLabel: s.timeLabel,
  };
  memory.summaries.push(rec);
  saveMemory();
  return rec;
}

/**
 * 删除一条摘要 + 它产生的全部衍生数据(sourceId 标记的物品、计划)。
 * 原文聊天楼层保持隐藏不动(只清记忆侧数据)。
 * 注意:仅能撤销该摘要「新增」的物品/计划;它做过的 update/remove/resolve 无法回滚(增量模型限制)。
 * 返回 true 表示删除成功。
 */
export function deleteSummary(id: string): boolean {
  const idx = memory.summaries.findIndex(s => s.id === id);
  if (idx < 0) return false;

  // 收集要清除的来源 id:本摘要;若是二次总结,连同它合并的下层摘要 id 一并清
  const sourceIds = new Set<string>([id]);
  for (const mid of memory.summaries[idx].mergedFrom ?? []) sourceIds.add(mid);

  memory.summaries.splice(idx, 1);
  memory.items = memory.items.filter(i => !i.sourceId || !sourceIds.has(i.sourceId));
  memory.plans = memory.plans.filter(p => !p.sourceId || !sourceIds.has(p.sourceId));

  saveMemory();
  return true;
}

/** 测试辅助:重置 id 序列(配合可注入时间) */
export function __resetIdSeq(): void {
  idSeq = 0;
}

/** 纯函数版 apply,用于单元测试(不触碰 store/持久化) */
export function applyDeltaTo(mem: BaibaiMemory, delta: SummaryDelta, t: number): void {
  // 覆盖型
  if (typeof delta.time === 'string' && delta.time.trim()) mem.state.time = delta.time.trim();
  if (typeof delta.location === 'string' && delta.location.trim()) mem.state.location = delta.location.trim();

  // 物品
  if (delta.items) {
    for (const add of delta.items.add ?? []) {
      if (!add?.name?.trim()) continue;
      const ex = mem.items.find(i => norm(i.name) === norm(add.name));
      if (ex) {
        if (typeof add.qty === 'number') ex.qty = (ex.qty ?? 0) + add.qty;
        if (add.desc) ex.desc = add.desc;
        ex.updatedAt = t;
      } else {
        mem.items.push({
          id: `item_${t}_${mem.items.length}`,
          name: add.name.trim(),
          desc: add.desc?.trim() || undefined,
          qty: typeof add.qty === 'number' ? add.qty : undefined,
          createdAt: t,
          updatedAt: t,
        });
      }
    }
    for (const upd of delta.items.update ?? []) {
      const it = mem.items.find(i => norm(i.name) === norm(upd.name));
      if (!it) continue;
      if (typeof upd.qty === 'number') it.qty = upd.qty;
      if (upd.desc) it.desc = upd.desc;
      it.updatedAt = t;
    }
    for (const name of delta.items.remove ?? []) {
      const idx = mem.items.findIndex(i => norm(i.name) === norm(name));
      if (idx >= 0) mem.items.splice(idx, 1);
    }
  }

  // 计划/悬念
  if (delta.plans) {
    for (const add of delta.plans.add ?? []) {
      if (!add?.content?.trim()) continue;
      const dup = mem.plans.find(p => p.kind === add.kind && norm(p.content) === norm(add.content) && p.status === 'open');
      if (dup) continue;
      mem.plans.push({
        id: `plan_${t}_${mem.plans.length}`,
        kind: add.kind === 'suspense' ? 'suspense' : 'plan',
        content: add.content.trim(),
        status: 'open',
        createdAt: t,
      });
    }
    if (delta.plans.resolve?.length) {
      const openPlans = mem.plans.filter(p => p.status === 'open');
      for (const ref of delta.plans.resolve) {
        const n = parseShortRef(ref);
        if (n === null) continue;
        const target = openPlans[n - 1];
        if (target) {
          target.status = 'resolved';
          target.resolvedAt = t;
        }
      }
    }
  }
}
