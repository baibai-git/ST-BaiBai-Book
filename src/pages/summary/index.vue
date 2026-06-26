<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { appendOpToLatestLeaf, deleteLeafAt, deleteSummary, editLeafAt, editPlan, editSummary } from '@/memory/apply';
import { apiSettings } from '@/api/settings';
import { engineState, resummarizeNow, summarizeFloor } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { compactTimeLabel, formatRange, splitTimeLabel } from '@/memory/timeTag';
import { relativeTimeLabel } from '@/memory/timeRel';
import { derivedMeta, memory, recomputeDerived } from '@/memory/store';
import { computed, nextTick, onMounted, ref } from 'vue';

// 打开摘要页时强制重算一次派生:未摘要楼层等派生缓存只在特定事件刷新,
// 边聊边攒的新 AI 楼可能没触发刷新,进页先对齐一次,避免列表漏楼。
onMounted(() => recomputeDerived());

// 触屏判定:用于跳过弹窗自动聚焦(移动端自动聚焦会弹出输入法挡住界面)。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* ============ 悬念簿(顶部)============ */
const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');
const newTargetTime = ref(''); // 手动添加计划时的可选目标时间(故事内时间)
// 手动添加是低频操作:用弹窗承载,平时只露一个小「+」按钮,不占版面。
const composerOpen = ref(false);
const contentInput = ref<HTMLTextAreaElement | null>(null);
function openComposer() {
  if (!hasLeaf.value) return;
  newKind.value = 'plan';
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = true;
  // 仅在非触屏自动聚焦:移动端自动聚焦会立刻弹出输入法,挡住弹窗、体验差。
  if (!isTouch) void nextTick(() => contentInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
// 计划/悬念只展示「进行中」。点删除即移除——不再有「了结/已了结」概念。
const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// 叶子 id → 创建楼层。计划 id 形如 `plan:${叶子id}#${序号}`,由此反查创建该计划/悬念
// 时所在楼层(与摘要列表的 #楼层 同源)。手动添加的计划挂在最新叶子上,显示其楼层。
const leafFloor = computed(() => {
  const m = new Map<string, number>();
  for (const l of derivedMeta.leaves) m.set(l.id, l.msgIndex);
  return m;
});
function planFloor(planId: string): number | undefined {
  const leafId = planId.replace(/^plan:/, '').replace(/#\d+$/, '');
  return leafFloor.value.get(leafId);
}

function addPlan() {
  const content = newContent.value.trim();
  if (!content) return;
  // 创建时间用当前已知故事时间(没有就留空);目标时间仅计划可填,用户填了才带上
  const createdTime = memory.state.time?.trim() || undefined;
  const targetTime = newKind.value === 'plan' ? newTargetTime.value.trim() || undefined : undefined;
  if (!appendOpToLatestLeaf({ plans: { add: [{ kind: newKind.value, content, createdTime, targetTime }] } })) return;
  newContent.value = '';
  newTargetTime.value = '';
  composerOpen.value = false;
}
function removePlan(id: string) {
  appendOpToLatestLeaf({ plans: { remove: [id] } });
}

/* —— 编辑计划/悬念(弹窗)—— */
const editingPlan = ref<{ id: string; kind: 'plan' | 'suspense'; content: string; createdTime: string; targetTime: string } | null>(null);
function openPlanEdit(p: { id: string; kind: 'plan' | 'suspense'; content: string; createdTime?: string; targetTime?: string }) {
  editingPlan.value = {
    id: p.id,
    kind: p.kind,
    content: p.content,
    createdTime: p.createdTime ?? '',
    targetTime: p.targetTime ?? '',
  };
}
function cancelPlanEdit() {
  editingPlan.value = null;
}
function savePlanEdit() {
  const e = editingPlan.value;
  if (!e || !e.content.trim()) return;
  editPlan(e.id, {
    content: e.content,
    createdTime: e.createdTime,
    // 目标时间仅计划有意义;悬念保持空
    targetTime: e.kind === 'plan' ? e.targetTime : '',
  });
  refreshInjection();
  editingPlan.value = null;
}

/* ============ 未摘要楼层 ============
 * derivedMeta.pendingFloors = AI 楼且无有效叶子,由旧到新;此处倒序展示(新楼在前)。 */
const pendingFloors = computed(() => [...derivedMeta.pendingFloors].sort((a, b) => b - a));
const summarizingFloor = ref<number | null>(null);
async function summarizeOne(floor: number) {
  if (engineState.running || summarizingFloor.value !== null) return;
  summarizingFloor.value = floor;
  try {
    await summarizeFloor(floor);
  } finally {
    summarizingFloor.value = null;
  }
}

/* ============ 立即总结 ============
 * 手动触发一次「检测是否达阈值 → 达到就总结(可连锁多层)」。结果用一句临时提示反馈。 */
const resummaryRunning = ref(false);
const resummaryHint = ref('');
let resummaryHintTimer: ReturnType<typeof setTimeout> | null = null;

// 总结节奏:实际约每「保留最近 AI 消息数 + 每次总结 AI 消息数」楼总结一次——
// 最近 keepRecent 条发全文不摘,更早的摘成叶子,叶子攒够 leafBatchThreshold 条压一次总结。
// 阈值关闭(<2)时不显示节奏句。
const resummaryEvery = computed(() => (Math.max(0, apiSettings.keepRecent) + apiSettings.leafBatchThreshold) * 2);
const showCadence = computed(() => apiSettings.leafBatchThreshold >= 2);

async function doResummarize() {
  if (resummaryRunning.value || engineState.running) return;
  resummaryRunning.value = true;
  resummaryHint.value = '';
  try {
    const made = await resummarizeNow();
    // 有报错优先显示错误(如未指派总结渠道);否则按生成条数给反馈
    if (engineState.lastError) {
      resummaryHint.value = '';
    } else if (made > 0) {
      resummaryHint.value = `已生成 ${made} 条总结`;
    } else {
      // 未达阈值:补一句动态节奏,告诉用户大概每多少楼总结一次
      const cadence = showCadence.value ? `,约每 ${resummaryEvery.value} 楼总结一次` : '';
      resummaryHint.value = `当前没有达到总结阈值的摘要${cadence}`;
    }
  } finally {
    resummaryRunning.value = false;
    if (resummaryHintTimer) clearTimeout(resummaryHintTimer);
    if (resummaryHint.value) resummaryHintTimer = setTimeout(() => (resummaryHint.value = ''), 4000);
  }
}

/* ============ 摘要列表(下方)============ */
/** 统一行:叶子(来自 chat 扫描的 derivedMeta.leaves)+ 压缩节点(来自森林) */
interface Row {
  key: string;
  kind: 'leaf' | 'comp';
  level: number;
  text: string;
  timeStart?: string;
  timeEnd?: string;
  timeLabel?: string; // 旧数据回退
  createdAt: number;
  sortKey: number;
  floorLo: number; // 覆盖楼层范围下界
  floorHi: number; // 覆盖楼层范围上界(leaf:与 lo 相同)
  msgIndex?: number; // leaf
  stale?: boolean; // leaf
}

// 森林:压缩节点 id → 节点。childIds 可指向叶子 id(L1)或下层压缩节点 id(L2+)。
const compById = computed(() => {
  const m = new Map<string, (typeof memory.summaries)[number]>();
  for (const s of memory.summaries) m.set(s.id, s);
  return m;
});
// 被任何压缩节点收纳的 id(叶子或下层节点)→ 即「已被总结」,列表里隐藏,只留森林的根。
const summarizedIds = computed(() => {
  const s = new Set<string>();
  for (const c of memory.summaries) for (const cid of c.childIds) s.add(cid);
  return s;
});
// 递归把一个节点(叶子或压缩节点)解析成它覆盖的所有叶子楼层号。
function collectFloors(id: string, acc: number[], seen: Set<string>): void {
  if (seen.has(id)) return;
  seen.add(id);
  const leafIdx = leafFloor.value.get(id);
  if (leafIdx !== undefined) {
    acc.push(leafIdx);
    return;
  }
  const comp = compById.value.get(id);
  if (!comp) return;
  for (const c of comp.childIds) collectFloors(c, acc, seen);
}

const ordered = computed<Row[]>(() => {
  const rows: Row[] = [];
  // 叶子:跳过已被总结的(被某压缩节点收纳)——它们由对应总结代表
  for (const l of derivedMeta.leaves) {
    if (summarizedIds.value.has(l.id)) continue;
    rows.push({
      key: `leaf:${l.id}`,
      kind: 'leaf',
      level: 0,
      text: l.text,
      timeStart: l.timeStart,
      timeEnd: l.timeEnd,
      timeLabel: l.timeLabel,
      createdAt: l.createdAt,
      sortKey: l.msgIndex,
      floorLo: l.msgIndex,
      floorHi: l.msgIndex,
      msgIndex: l.msgIndex,
      stale: l.stale,
    });
  }
  // 压缩节点:只显示根(未被上层收纳的);楼层范围 = 覆盖的全部叶子楼层 min..max
  for (const s of memory.summaries) {
    if (summarizedIds.value.has(s.id)) continue;
    const floors: number[] = [];
    collectFloors(s.id, floors, new Set());
    const lo = floors.length ? Math.min(...floors) : -1;
    const hi = floors.length ? Math.max(...floors) : -1;
    rows.push({
      key: `comp:${s.id}`,
      kind: 'comp',
      level: s.level,
      text: s.text,
      timeLabel: s.timeLabel,
      createdAt: s.createdAt,
      // 排序用覆盖范围上界(最新楼层),与叶子楼层同尺度,倒序时落在对应位置
      sortKey: hi,
      floorLo: lo,
      floorHi: hi,
    });
  }
  // 倒序:楼层越靠后越在上面
  return rows.sort((a, b) => b.sortKey - a.sortKey);
});

/** 行的展示时间:新数据用 timeStart/timeEnd 合成并压缩;旧数据回退到已固化的 timeLabel(也压缩一次) */
function rowTime(r: Row): string {
  if (r.timeStart || r.timeEnd) return formatRange(r.timeStart, r.timeEnd);
  return r.timeLabel ? compactTimeLabel(r.timeLabel) : '';
}
/** 行的相对时间前缀(如「昨天」):参照故事内最新时间;无法解析则空串 */
function rowRelative(r: Row): string {
  const event = r.timeEnd || r.timeStart || (r.timeLabel ? splitTimeLabel(r.timeLabel).end : '') || '';
  return relativeTimeLabel(event, derivedMeta.latestStoryTime);
}

// 当前时间:优先读正文标签实时算出的「故事内最新时间」(不受最新楼是否已摘影响);
// 取不到再回退派生的 state.time(老数据/无标签场景)。修掉「最新楼未摘时显示旧时间」的问题。
const currentTime = computed(() => derivedMeta.latestStoryTime || memory.state.time);

function levelLabel(level: number): string {
  if (level === 0) return '摘要';
  return `总结L${level}`;
}
/** 楼层范围标签:单楼 #5,跨楼 #0 - #10 */
function floorLabel(r: Row): string {
  if (r.floorLo < 0) return '—';
  return r.floorLo === r.floorHi ? `#${r.floorLo}` : `#${r.floorLo} - #${r.floorHi}`;
}

function onDelete(r: Row) {
  if (r.kind === 'leaf') {
    if (!confirm('删除这条摘要?它带来的物品、计划、时间地点变化会按剩余摘要重新计算(可能回退);包含它的总结也会一并删除。原文楼层仍保持隐藏。')) return;
    if (typeof r.msgIndex === 'number') deleteLeafAt(r.msgIndex);
  } else {
    if (!confirm('删除这条总结?被它收纳的下层摘要会重新展开,物品/计划等不受影响。')) return;
    deleteSummary(r.key.slice('comp:'.length));
  }
  refreshInjection();
}

/* ============ 编辑弹窗 ============
 * 叶子:可改「故事内时间」+ 正文;总结:只压文本,故只改正文。 */
type Editing =
  | { kind: 'leaf'; msgIndex: number; text: string; timeStart: string; timeEnd: string }
  | { kind: 'comp'; compId: string; level: number; text: string };
const editing = ref<Editing | null>(null);

function openEdit(r: Row) {
  if (r.kind === 'leaf' && typeof r.msgIndex === 'number') {
    // 旧数据无 timeStart/timeEnd 时,从已固化的 timeLabel 拆出起止填入
    const fb = !r.timeStart && !r.timeEnd ? splitTimeLabel(r.timeLabel) : {};
    editing.value = {
      kind: 'leaf',
      msgIndex: r.msgIndex,
      text: r.text,
      timeStart: r.timeStart ?? fb.start ?? '',
      timeEnd: r.timeEnd ?? fb.end ?? '',
    };
  } else if (r.kind === 'comp') {
    editing.value = { kind: 'comp', compId: r.key.slice('comp:'.length), level: r.level, text: r.text };
  }
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e) return;
  if (e.kind === 'leaf') editLeafAt(e.msgIndex, e.text, e.timeStart, e.timeEnd);
  else editSummary(e.compId, e.text);
  refreshInjection();
  editing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <!-- ===== 悬念簿 ===== -->
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">悬念簿</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? '手动添加计划 / 悬念' : '需先有摘要才能手动添加'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>

    <div v-if="openPlans.length" class="bbs-plan-group">
      <div v-for="p in openPlans" :key="p.id" class="bbs-plan">
        <div class="bbs-plan-head">
          <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? '悬念' : '计划' }}</span>
          <span v-if="planFloor(p.id) !== undefined" class="bbs-plan-floor">#{{ planFloor(p.id) }}</span>
          <span class="bbs-plan-acts">
            <button class="bbs-plan-act" type="button" title="编辑" @click="openPlanEdit(p)"><Icon name="edit" /></button>
            <button class="bbs-plan-act bbs-plan-del" type="button" title="删除" @click="removePlan(p.id)"><Icon name="close" /></button>
          </span>
        </div>
        <p class="bbs-plan-content">{{ p.content }}</p>
        <!-- 故事内时间:立于(创建时间)/ 目标(目标时间),任一存在才显示 -->
        <div v-if="p.createdTime || p.targetTime" class="bbs-plan-times">
          <span v-if="p.createdTime" class="bbs-plan-time">立于 {{ p.createdTime }}</span>
          <span v-if="p.targetTime" class="bbs-plan-time bbs-plan-time-target">目标 {{ p.targetTime }}</span>
        </div>
      </div>
    </div>
    <p v-else class="bbs-plan-empty">还没有计划或悬念。摘要时会自动捕捉,也可手动添加。</p>

    <!-- 分章分隔:两侧细线 + 居中金色菱形(古籍分章鱼尾标记),比普通 hr 更明确地隔开两区 -->
    <div class="bbs-divider" role="separator" aria-hidden="true">
      <span class="bbs-divider-mark"></span>
    </div>

    <!-- ===== 摘要 ===== -->
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">摘要</h2>
      <button
        class="bbs-btn bbs-btn-sm bbs-resummary-btn"
        type="button"
        :disabled="resummaryRunning || engineState.running"
        title="检测摘要是否达到总结阈值,达到则立即总结一次"
        @click="doResummarize"
      >
        <span v-if="resummaryRunning" class="bbs-pending-spin"></span>
        <Icon v-else name="plans" />
        立即总结
      </button>
    </div>
    <p v-if="resummaryHint" class="bbs-resummary-hint">{{ resummaryHint }}</p>

    <!-- 未摘要楼层:只列楼层号,点一下单独补摘那一楼 -->
    <div v-if="pendingFloors.length" class="bbs-pending">
      <span class="bbs-pending-label" :data-count="pendingFloors.length">
        <Icon name="summary" />未摘要楼层
      </span>
      <div class="bbs-pending-chips">
        <button
          v-for="f in pendingFloors"
          :key="f"
          class="bbs-pending-chip"
          type="button"
          :disabled="engineState.running || summarizingFloor !== null"
          :title="`对楼层 #${f} 生成摘要`"
          @click="summarizeOne(f)"
        >
          <span v-if="summarizingFloor === f" class="bbs-pending-spin"></span>
          <template v-else>#{{ f }}</template>
        </button>
      </div>
    </div>

    <!-- 当前状态 -->
    <div v-if="currentTime || memory.state.location" class="bbs-state">
      <div v-if="currentTime" class="bbs-state-item">
        <span class="bbs-state-key">时间</span>
        <span class="bbs-state-val">{{ currentTime }}</span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">地点</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <p v-if="engineState.lastError" class="bbs-error">{{ engineState.lastError }}</p>

    <div v-if="ordered.length" class="bbs-summary-list">
      <article
        v-for="r in ordered"
        :key="r.key"
        class="bbs-summary-card"
        :class="{ 'is-deep': r.level > 0, 'is-stale': r.stale }"
      >
        <header class="bbs-summary-meta">
          <!-- 总结:保留层级标签 + 范围药丸 + 时间(多条合并,需要标识层级) -->
          <template v-if="r.kind === 'comp'">
            <span class="bbs-summary-badge">{{ levelLabel(r.level) }}</span>
            <span class="bbs-summary-loc">{{ floorLabel(r) }}</span>
            <span v-if="rowTime(r)" class="bbs-summary-time">
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>{{ rowTime(r) }}
            </span>
          </template>
          <!-- 摘要:时间作日期题首,楼层用中点轻接;无时间时楼层自身升为题首 -->
          <template v-else>
            <span v-if="rowTime(r)" class="bbs-summary-dateline">
              <span v-if="rowRelative(r)" class="bbs-summary-rel">({{ rowRelative(r) }})</span>{{ rowTime(r) }}
            </span>
            <span class="bbs-summary-floor-inline" :class="{ 'is-lead': !rowTime(r) }">{{ floorLabel(r) }}</span>
          </template>
          <span v-if="r.stale" class="bbs-summary-stale">待更新</span>
          <span class="bbs-summary-acts">
            <button
              class="bbs-summary-act"
              type="button"
              :title="r.kind === 'comp' ? '编辑总结' : '编辑摘要'"
              @click="openEdit(r)"
            >
              <Icon name="edit" />
            </button>
            <button
              class="bbs-summary-act bbs-summary-del"
              type="button"
              :title="r.kind === 'comp' ? '删除总结(下层会展开)' : '删除摘要'"
              @click="onDelete(r)"
            >
              <Icon name="trash" />
            </button>
          </span>
        </header>
        <p class="bbs-summary-text">{{ r.text }}</p>
      </article>
    </div>
    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="summary" /></span>
      <p>还没有摘要。对话累积到设定楼层后会自动生成,也可在「未摘要楼层」里点楼层号单独补摘。</p>
    </div>

    <!-- ===== 添加计划 / 悬念弹窗 ===== -->
    <div v-if="composerOpen" class="bbs-modal-mask" @click.self="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加计划或悬念">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加计划 / 悬念</span>
          <button class="bbs-summary-act" type="button" title="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <div class="bbs-modal-field">
          <span class="bbs-modal-label">类型</span>
          <div class="bbs-kind-toggle">
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'plan' }" @click="newKind = 'plan'">计划</button>
            <button type="button" class="bbs-kind" :class="{ 'is-on': newKind === 'suspense' }" @click="newKind = 'suspense'">悬念</button>
          </div>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">内容</span>
          <textarea
            ref="contentInput"
            v-model="newContent"
            class="bbs-input bbs-modal-textarea"
            rows="3"
            placeholder="描述这条计划或悬念…"
            @keydown.enter.exact.prevent="addPlan"
          ></textarea>
        </label>
        <!-- 目标时间仅「计划」可填,可选;悬念一般无目标时间故不显示 -->
        <label v-if="newKind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">目标时间(可选)</span>
          <input
            v-model="newTargetTime"
            class="bbs-input"
            type="text"
            placeholder="如 放学后 / 1988/10/1;模糊或留空都可"
          />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newContent.trim()" @click="addPlan">添加</button>
        </footer>
      </div>
    </div>

    <!-- ===== 编辑计划 / 悬念弹窗 ===== -->
    <div v-if="editingPlan" class="bbs-modal-mask" @click.self="cancelPlanEdit">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑计划或悬念">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑{{ editingPlan.kind === 'suspense' ? '悬念' : '计划' }}</span>
          <button class="bbs-summary-act" type="button" title="关闭" @click="cancelPlanEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">内容</span>
          <textarea v-model="editingPlan.content" class="bbs-input bbs-modal-textarea" rows="3"></textarea>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">创建时间(可选)</span>
          <input v-model="editingPlan.createdTime" class="bbs-input" type="text" placeholder="故事内时间,如 1988/9/29" />
        </label>
        <label v-if="editingPlan.kind === 'plan'" class="bbs-modal-field">
          <span class="bbs-modal-label">目标时间(可选)</span>
          <input v-model="editingPlan.targetTime" class="bbs-input" type="text" placeholder="如 放学后 / 1988/10/1;模糊或留空都可" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelPlanEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editingPlan.content.trim()" @click="savePlanEdit">保存</button>
        </footer>
      </div>
    </div>

    <!-- ===== 编辑弹窗 ===== -->
    <!-- 不用 Teleport:Teleport to="body" 会把弹窗送到 shadow root 之外的 light DOM,
         那里既拿不到本组件的 scoped 样式、也拿不到 --bbs-* 主题变量(变量定义在 shadow
         内的 .bbs-root 上),导致弹窗无样式、被遮罩盖住(PC)甚至完全不可见(移动端)。
         弹窗本身 position:fixed,直接内联渲染即可覆盖全窗,且样式/变量都正常生效。 -->
    <div v-if="editing" class="bbs-modal-mask" @click.self="cancelEdit">
      <div class="bbs-modal" role="dialog" aria-modal="true" :aria-label="editing.kind === 'comp' ? '编辑总结' : '编辑摘要'">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">
            {{ editing.kind === 'comp' ? `编辑${levelLabel(editing.level)}` : `编辑摘要 · 楼层 #${editing.msgIndex}` }}
          </span>
          <button class="bbs-summary-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <!-- 时间仅叶子可编辑(起止两端);总结只压文本,无时间字段 -->
        <div v-if="editing.kind === 'leaf'" class="bbs-modal-field bbs-time-pair">
          <label class="bbs-time-col">
            <span class="bbs-modal-label">起始时间</span>
            <input v-model="editing.timeStart" class="bbs-input" type="text" placeholder="如 1988/9/29 21:00" />
          </label>
          <label class="bbs-time-col">
            <span class="bbs-modal-label">结束时间</span>
            <input v-model="editing.timeEnd" class="bbs-input" type="text" placeholder="如 1988/9/29 21:30" />
          </label>
        </div>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">{{ editing.kind === 'comp' ? '总结正文' : '摘要正文' }}</span>
          <textarea v-model="editing.text" class="bbs-input bbs-modal-textarea" rows="8"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" @click="saveEdit">保存</button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
/* 起止时间:两个输入框并排,各占一半 */
.bbs-time-pair {
  display: flex;
  gap: 10px;
}
.bbs-time-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bbs-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
/* —— 悬念簿 —— */
/* 标题旁的小「+」:无框、muted,平时低调,hover 才浮现强调色 */
.bbs-add-mini {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 15px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-add-mini:hover:not(:disabled) {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-add-mini:disabled {
  opacity: 0.4;
  cursor: default;
}
.bbs-kind-toggle {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 3px;
  background: var(--bbs-surface-2);
  border-radius: var(--bbs-radius-sm);
}
.bbs-kind {
  padding: 5px 12px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-soft);
  font-size: 12px;
  cursor: pointer;
}
.bbs-kind.is-on {
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  box-shadow: 0 1px 2px oklch(0 0 0 / 0.08);
}
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
}
/* 卡片竖排:标签行在上(类型药丸 + 右侧小删除键),内容占满整宽在下 */
.bbs-plan {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
/* 标签行:类型药丸靠左,删除键推到最右 */
.bbs-plan-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 类型标签:小药丸,用颜色区分计划/悬念 */
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 楼层号:创建该计划/悬念时所在楼层,描边定位标签;与摘要列表 #楼层 同款观感 */
.bbs-plan-floor {
  flex: 0 0 auto;
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
/* 动作组(编辑/删除)推到最右;平时低调,桌面 hover/聚焦该卡才浮现 */
.bbs-plan-acts {
  margin-left: auto;
  flex: 0 0 auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-plan:hover .bbs-plan-acts,
.bbs-plan:focus-within .bbs-plan-acts {
  opacity: 1;
}
/* 单个动作键:小而 muted */
.bbs-plan-act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-plan-act:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-plan-del:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
/* 内容:独占整宽,自然换行 */
.bbs-plan-content {
  margin: 0;
  font-size: 14px;
  line-height: 1.55;
  color: var(--bbs-ink);
  word-break: break-word;
}
/* 计划时间:立于/目标 两枚小标签,描边低调,目标用强调色区分 */
.bbs-plan-times {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-plan-time {
  font-size: 11px;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  padding: 1px 7px;
}
.bbs-plan-time-target {
  color: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-empty {
  margin: 14px 0 0;
  font-size: 13px;
  color: var(--bbs-ink-muted);
}

/* —— 当前状态 —— */
.bbs-state {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 20px;
  margin-top: 12px;
}
.bbs-state-item {
  display: flex;
  align-items: center;
  gap: 8px;
}
.bbs-state-key {
  font-size: 11px;
  color: var(--bbs-accent);
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-pill);
  padding: 1px 8px;
}
.bbs-state-val {
  font-size: 14px;
  color: var(--bbs-ink);
}

.bbs-error {
  margin: 12px 0 0;
  font-size: 12px;
  color: var(--bbs-danger);
}

/* —— 立即总结按钮:摘要标题右侧的次级操作,小一号,带图标 —— */
.bbs-resummary-btn {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 11px;
  font-size: 12px;
}
/* 复用未摘要楼层的旋转环(.bbs-pending-spin),此处微调尺寸贴合按钮文字 */
.bbs-resummary-btn .bbs-pending-spin {
  width: 12px;
  height: 12px;
}
.bbs-resummary-hint {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}

/* —— 未摘要楼层:待办面板,用强调色描边的卡片框起来,提示「这些楼还没摘」 —— */
.bbs-pending {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 14px;
  padding: 12px 14px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius);
  background: var(--bbs-accent-soft);
}
.bbs-pending-label {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--bbs-accent);
}
/* 标签后跟一枚计数小点,强化「有 N 楼待办」 */
.bbs-pending-label::after {
  content: attr(data-count);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.bbs-pending-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-pending-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-pending-chip:hover:not(:disabled) {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
}
.bbs-pending-chip:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 生成中:小旋转环替代楼层号 */
.bbs-pending-spin {
  width: 13px;
  height: 13px;
  border: 2px solid var(--bbs-line-strong);
  border-top-color: var(--bbs-accent);
  border-radius: 50%;
  animation: bbs-pending-rot 0.7s linear infinite;
}
@keyframes bbs-pending-rot {
  to {
    transform: rotate(360deg);
  }
}

/* —— 分章分隔:计划/悬念 与 摘要 两区之间的明确界线 —— */
/* 两侧细线在中间断开,嵌一枚金色小菱形——古籍分章的鱼尾标记,呼应纸墨主题 */
.bbs-divider {
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 26px 0;
}
.bbs-divider::before,
.bbs-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--bbs-line-strong);
}
.bbs-divider-mark {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  transform: rotate(45deg);
  background: var(--bbs-accent);
  border-radius: 1px;
}

/* —— 摘要列表 —— */
.bbs-summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 14px;
}
.bbs-summary-card {
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  padding: 14px 16px;
}
.bbs-summary-card.is-deep {
  border-left: 3px solid var(--bbs-accent);
}
.bbs-summary-card.is-stale {
  opacity: 0.6;
}
.bbs-summary-stale {
  font-size: 11px;
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
  border-radius: var(--bbs-radius-sm);
  padding: 2px 8px;
}
.bbs-summary-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
/* 摘要题首:故事内时间升为主标题,稍大、半粗、tabular 数字像账册日期 */
.bbs-summary-dateline {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
/* 楼层:用中点轻接在日期后,弱化为副信息;无时间时(.is-lead)自身升为题首 */
.bbs-summary-floor-inline {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
.bbs-summary-floor-inline::before {
  content: '·';
  margin-right: 8px;
  color: var(--bbs-ink-muted);
}
.bbs-summary-floor-inline.is-lead {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
}
.bbs-summary-floor-inline.is-lead::before {
  content: none;
}
/* 标签与楼层号:高度一致(同 height + 居中);楼层号最小宽 = 摘要标签宽,数字变长再撑开 */
.bbs-summary-badge,
.bbs-summary-loc {
  box-sizing: border-box;
  height: 22px;
  min-width: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  border-radius: var(--bbs-radius-sm);
}
.bbs-summary-badge {
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border: 1px solid var(--bbs-accent); /* 与 loc 同样有 1px 边框,保证两者等高 */
}
/* 楼层号/收纳数:描边定位标签;tabular 数字对齐 */
.bbs-summary-loc {
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface-2);
  border: 1px solid var(--bbs-line);
  font-variant-numeric: tabular-nums;
}
.bbs-summary-time {
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
/* 相对时间前缀(昨天/3天前…):弱化为强调色小字,贴在绝对时间前 */
.bbs-summary-rel {
  margin-right: 4px;
  color: var(--bbs-accent);
  font-weight: 600;
}
/* 动作组靠右;平时隐身,hover/聚焦该卡才浮现 */
.bbs-summary-acts {
  margin-left: auto;
  display: inline-flex;
  gap: 2px;
  opacity: 0;
  transition: opacity 0.15s;
}
.bbs-summary-card:hover .bbs-summary-acts,
.bbs-summary-card:focus-within .bbs-summary-acts {
  opacity: 1;
}
.bbs-summary-act {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--bbs-ink-muted);
  border-radius: var(--bbs-radius-sm);
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.bbs-summary-act:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-summary-del:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-summary-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.8;
  letter-spacing: 0.025em;
  color: var(--bbs-ink-soft);
  white-space: pre-wrap;
}

.bbs-empty {
  flex: 1;
}

/* —— 编辑弹窗:外壳样式已提到 base.css 通用,这里只补本页专用的 textarea —— */
.bbs-modal-textarea {
  resize: vertical;
  min-height: 120px;
  line-height: 1.6;
  font-family: var(--bbs-font-sans);
}

/* ============ 触屏:没有 hover,动作键常显但低调(非大色块) ============ */
@media (hover: none) {
  /* 触屏看不到 hover 浮现,编辑/删除键必须常显——但保持小而 muted,不喧宾夺主 */
  .bbs-plan-acts,
  .bbs-summary-acts {
    opacity: 1;
  }
  /* 触达区略放大到 ~32px(够点),图标维持小巧;不再是 40×40 的常亮大块 */
  .bbs-plan-act,
  .bbs-summary-act {
    width: 32px;
    height: 32px;
    font-size: 15px;
  }
  .bbs-summary-act {
    color: var(--bbs-ink-muted);
  }
}

/* ============ 窄屏:类型切换撑满、状态条整齐 ============ */
@media (max-width: 640px) {
  /* 添加弹窗里的类型切换:计划 | 悬念 各占一半,撑满整行 */
  .bbs-kind-toggle {
    width: 100%;
  }
  .bbs-kind {
    flex: 1;
  }

  /* 时间/地点:窄屏整齐堆叠成两行,长地点不再把行挤乱 */
  .bbs-state {
    flex-direction: column;
    gap: 8px;
  }
}
</style>
