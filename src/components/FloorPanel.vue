<script setup lang="ts">
/**
 * 楼内摘要面板(挂在每条 AI 楼的 shadow 内,由 floorPanel.ts 逐楼挂载)。
 *
 * 形态:一张与摘要页同源的卡片(.bbs-summary-card 语言)。
 *   - 卡片头(锚点):严格单行 —— 楼号 + 摘要预览 + 番外键 + 展开箭头。
 *   - 卡片体(抽屉):grid 0fr↔1fr 高度过渡(同 SummaryNode.vue,内容常驻不脱流,无闪烁)。
 *     变动按类型分组、以「标签流」横向排列。
 *
 * 编辑:**逐条就地编辑**。点摘要正文 / 时间 / 地点 / 某条变动标签,就地展开该单元的输入框,
 *   保存即写、取消即收,其余保持只读。同一时刻只有一个单元在编辑(editKey)。
 *   写走 apply.ts 的 editLeafFull(整体重放),targeted 修改由 commitDelta 克隆-改-回写完成。
 *
 * 数据:chat 非 reactive。leaf 返回浅拷贝(新引用)+ 追踪 sig.tick / derivedMeta.rev,
 *   任何来源(ST 事件、主界面摘要、楼内编辑)的变化都能刷新。
 */
import { computed, nextTick, reactive, ref, watch } from 'vue';
import Icon from '@/components/Icon.vue';
import { getContext, type STMessage } from '@/st/context';
import { getLeaf, leafValid, deleteLeafAt, editLeafFull, planContentById } from '@/memory/apply';
import { setFloorOmit } from '@/memory/engine';
import { derivedMeta } from '@/memory/store';
import { ui } from '@/state/ui';
import type { LeafExtra, StoredDelta, ItemDelta, NpcDelta } from '@/memory/types';

const props = defineProps<{ floor: number; sig: { tick: number } }>();

// —— 读当前楼消息/叶子。两个刷新源都追踪:
//   · sig.tick:注入宿主的 ST 事件(渲染/翻页/切聊天)
//   · derivedMeta.rev:任何 recomputeDerived(主界面摘要、楼内编辑、引擎自动摘要)
const msg = computed<STMessage | undefined>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return getContext()?.chat?.[props.floor];
});
// ⚠️ msg 返回 chat[floor] 同一对象引用(原地改标记/叶子,引用不变),Vue computed 靠 === 判定
// 会认为 msg「没变」而不向下游传播。故 omit/valid/leaf 都必须**各自**直接追踪 rev/tick,
// 不能只靠 msg —— 否则番外标记切换后 omit 不刷新(番外按钮状态不变,是这个 bug 的根因)。
const omit = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return !!msg.value?.extra?.bbs_omit;
});
// leaf 还额外返回浅拷贝(新引用),让依赖 leaf 的下游(d/*Tags/preview)也强制重算。
const leaf = computed<LeafExtra | null>(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  const l = getLeaf(msg.value);
  return l ? { ...l } : null;
});
const valid = computed(() => {
  void props.sig.tick;
  void derivedMeta.rev;
  return leafValid(msg.value);
});
const d = computed<StoredDelta | null>(() => leaf.value?.delta ?? null);

const expanded = ref(false);
const busy = ref(false);

const previewText = computed(() => {
  if (omit.value) return '不计入记忆';
  if (valid.value && leaf.value?.text) return leaf.value.text;
  return valid.value ? '(无摘要正文)' : '待摘要';
});
const previewMuted = computed(() => omit.value || !(valid.value && leaf.value?.text));

const timeLabel = computed(() => {
  const l = leaf.value;
  if (!l) return '';
  const s = l.timeStart?.trim();
  const e = l.timeEnd?.trim();
  if (s && e && s !== e) return `${s} → ${e}`;
  return s || e || l.timeLabel?.trim() || '';
});

/* ============ 变动 → 标签行(带定位信息,供就地编辑用) ============ */
type Op = 'add' | 'update' | 'remove' | 'resolve' | 'reopen' | 'reparent';
// 单字符曾让人费解(「改」是什么?),改用明确词条 + 语义色徽标(见 .bbs-fp-op 的 op-* 着色)
const opLabel: Record<Op, string> = { add: '新增', update: '更新', remove: '移除', resolve: '达成', reopen: '重启', reparent: '迁移' };

// key 用于定位到 delta 里的具体桶+序号,如 'item:add:0'
// text=主文本(名字/标题,一行),sub=副文本(描述/字段细节,淡色小字另起一行)。
// 之前把所有细节挤进一行、加大圆角、还居中,长内容就成了臃肿的居中泡泡。拆成「主 + 副」的
// 账册式左对齐条目后,名字为纲、细节为目,长短皆可读。
interface Tag {
  key: string;
  op: Op;
  bucket: string; // add/update/remove/reparent/resolve/reopen
  idx: number;
  text: string;
  sub?: string; // 副文本(可选)
  editable: boolean; // items/npcs 可就地改字段;scenes/plans 只可删
}

function fmtItem(x: ItemDelta): { text: string; sub?: string } {
  const text = typeof x.qty === 'number' ? `${x.name} ×${x.qty}` : x.name;
  return { text, sub: x.desc || undefined };
}
// 角色可编辑的文本字段注册表:统一驱动「展示副文本 / 编辑载入 / 保存 / 按需渲染输入框」,
// 一处定义,避免多处重复且保证一致。key=NpcDelta 字段名,draft=edit 草稿字段名,label=展示/占位。
const NPC_FIELDS = [
  { key: 'title', draft: 'title', label: '身份' },
  { key: 'outfit', draft: 'outfit', label: '着装' },
  { key: 'condition', draft: 'condition', label: '状态' },
  { key: 'desc', draft: 'npcDesc', label: '外貌' },
  { key: 'personality', draft: 'personality', label: '性格' },
  { key: 'location', draft: 'npcLoc', label: '位置' },
] as const;

// 角色变动:主文本=名(·身份);副文本=delta 里本轮出现的字段。更新 delta 只含被改字段,
// 故副文本恰好就是「这层楼改了什么」——之前挤在一行还居中,极难读,拆成副行后清爽。
function fmtNpc(x: NpcDelta): { text: string; sub?: string } {
  const text = x.title ? `${x.name}·${x.title}` : x.name;
  const parts: string[] = [];
  // 身份已进主文本(名·身份),副文本从「着装」起,避免重复
  if (x.outfit) parts.push(`着装:${x.outfit}`);
  if (x.condition) parts.push(`状态:${x.condition}`);
  if (x.desc) parts.push(`外貌:${x.desc}`);
  if (x.personality) parts.push(`性格:${x.personality}`);
  if (x.location) parts.push(`位置:${x.location}`);
  if (x.follow === true) parts.push('随行');
  if (x.important === true) parts.push('主要角色');
  return { text, sub: parts.length ? parts.join(' · ') : undefined };
}

const itemTags = computed<Tag[]>(() => {
  const it = d.value?.items;
  if (!it) return [];
  const out: Tag[] = [];
  (it.add ?? []).forEach((x, i) => out.push({ key: `item:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtItem(x), editable: true }));
  (it.update ?? []).forEach((x, i) => out.push({ key: `item:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtItem(x), editable: true }));
  (it.remove ?? []).forEach((name, i) => out.push({ key: `item:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
});
const npcTags = computed<Tag[]>(() => {
  const np = d.value?.npcs;
  if (!np) return [];
  const out: Tag[] = [];
  (np.add ?? []).forEach((x, i) => out.push({ key: `npc:add:${i}`, op: 'add', bucket: 'add', idx: i, ...fmtNpc(x), editable: true }));
  (np.update ?? []).forEach((x, i) => out.push({ key: `npc:update:${i}`, op: 'update', bucket: 'update', idx: i, ...fmtNpc(x), editable: true }));
  (np.remove ?? []).forEach((name, i) => out.push({ key: `npc:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: name, editable: true }));
  return out;
});
const sceneTags = computed<Tag[]>(() => {
  const sc = d.value?.scenes;
  if (!sc) return [];
  const out: Tag[] = [];
  (sc.add ?? []).forEach((x, i) => out.push({ key: `scene:add:${i}`, op: 'add', bucket: 'add', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.update ?? []).forEach((x, i) => out.push({ key: `scene:update:${i}`, op: 'update', bucket: 'update', idx: i, text: (x.path ?? []).join(' / '), editable: false }));
  (sc.reparent ?? []).forEach((x, i) => out.push({ key: `scene:reparent:${i}`, op: 'reparent', bucket: 'reparent', idx: i, text: `${(x.node ?? []).join('/')} → ${(x.newPath ?? []).join('/')}`, editable: false }));
  (sc.remove ?? []).forEach((p, i) => out.push({ key: `scene:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: (p ?? []).join(' / '), editable: false }));
  return out;
});
const planTags = computed<Tag[]>(() => {
  const pl = d.value?.plans;
  if (!pl) return [];
  const out: Tag[] = [];
  (pl.add ?? []).forEach((x, i) =>
    out.push({ key: `plan:add:${i}`, op: 'add', bucket: 'add', idx: i, text: x.content, sub: x.kind === 'suspense' ? '悬念' : '计划', editable: true }),
  );
  // resolve/reopen/remove 存 id,反查内容显示
  (pl.resolve ?? []).forEach((id, i) => out.push({ key: `plan:resolve:${i}`, op: 'resolve', bucket: 'resolve', idx: i, text: planLabel('了结', id), editable: false }));
  (pl.reopen ?? []).forEach((id, i) => out.push({ key: `plan:reopen:${i}`, op: 'reopen', bucket: 'reopen', idx: i, text: planLabel('重启', id), editable: false }));
  (pl.remove ?? []).forEach((id, i) => out.push({ key: `plan:remove:${i}`, op: 'remove', bucket: 'remove', idx: i, text: planLabel('删除', id), editable: false }));
  return out;
});
function planLabel(verb: string, id: string): string {
  void derivedMeta.rev;
  const c = planContentById(id);
  return c ? `${verb}:${c}` : `${verb}一项`;
}

const hasAnyDelta = computed(
  () => itemTags.value.length || npcTags.value.length || sceneTags.value.length || planTags.value.length || !!d.value?.location,
);

/* ============ 就地编辑 ============ */
// 当前正在编辑的单元:'text' | 'time' | 'loc' | tag.key(如 'item:add:0');null=无
const editKey = ref<string | null>(null);
// 单元编辑草稿(按需填,不同单元用不同字段)。
// npc 字段独立(title/outfit/condition/npcDesc/personality/npcLoc),不再拿 desc 兼作 title——
// 之前角色编辑只暴露名字+身份,着装/状态/外貌/性格/位置能看不能改,故补齐。
const edit = reactive<{
  text: string; timeStart: string; timeEnd: string; location: string;
  name: string; qty: string; desc: string; content: string;
  title: string; outfit: string; condition: string; npcDesc: string; personality: string; npcLoc: string;
}>({
  text: '',
  timeStart: '',
  timeEnd: '',
  location: '',
  name: '',
  qty: '',
  desc: '',
  content: '',
  title: '',
  outfit: '',
  condition: '',
  npcDesc: '',
  personality: '',
  npcLoc: '',
});

// 叶子消失 / 番外时退出编辑
watch([omit, leaf], () => {
  if (editKey.value && (omit.value || !leaf.value)) editKey.value = null;
});

// 触屏判定:移动端进入编辑不自动聚焦——自动 focus 会立刻弹出输入法,挡住界面。
// 让用户主动点输入框才弹,更舒服(与主界面摘要弹窗同款取舍)。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

// 用函数 ref(而非字符串 ref):字符串 ref 出现在 v-for 内会被 Vue 收集成**数组**,
// focusEl.value 变数组、没有 .focus() → 报「focus is not a function」。函数 ref 只在元素
// 挂载时被调用一次,稳稳拿到单个元素。
const focusEl = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);
function setFocus(el: unknown) {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) focusEl.value = el;
}
function beginEdit(key: string) {
  if (omit.value || !leaf.value) return;
  focusEl.value = null; // 清掉上一次编辑的(已卸载)输入框引用,避免 focus 到游离节点
  editKey.value = key;
  void nextTick(() => {
    // 编辑区内所有 textarea 都要 autosize(字段用可换行显示的 textarea,进场先贴合内容高)
    autosizeAll();
    if (!isTouch) focusEl.value?.focus();
  });
}
// textarea 自适应高度:进入编辑时若仍用固定行数,长内容会瞬间缩短、抽屉回弹(看到「摘要区缩起来」)。
// 让编辑框贴合内容高度,与只读态视觉连续,消除跳动。
function autosize(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}
// 对 focusEl 所在编辑卡内的全部 textarea 逐一 autosize(多字段编辑时不止一个)
function autosizeAll() {
  const root = focusEl.value?.closest('.bbs-fp-editform, .bbs-fp-texteditor');
  root?.querySelectorAll('textarea').forEach(t => autosize(t as HTMLTextAreaElement));
  if (focusEl.value instanceof HTMLTextAreaElement) autosize(focusEl.value);
}
function onTextInput(e: Event) {
  autosize(e.target as HTMLTextAreaElement);
}
// 字段 textarea:输入时 autosize;回车不换行(拦截 Enter,保持「单行语义、多行显示」)。
// Shift+Enter 也拦——这些是短字段,不需要真正的换行。
function onFieldKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') e.preventDefault();
}
function cancelEdit() {
  editKey.value = null;
}

/** 克隆当前 delta,交给 mutator 改,再整体重放写回。 */
function commitDelta(mutate: (dd: StoredDelta) => void): void {
  const l = leaf.value;
  if (!l) return;
  const dd: StoredDelta = JSON.parse(JSON.stringify(l.delta ?? {}));
  mutate(dd);
  editLeafFull(props.floor, {
    text: l.text ?? '',
    timeStart: l.timeStart ?? '',
    timeEnd: l.timeEnd ?? '',
    delta: dd,
  });
  editKey.value = null;
}

/* —— 正文 —— */
function editText() {
  edit.text = leaf.value?.text ?? '';
  beginEdit('text');
}
function saveText() {
  const l = leaf.value;
  if (!l) return;
  editLeafFull(props.floor, { text: edit.text, timeStart: l.timeStart ?? '', timeEnd: l.timeEnd ?? '', delta: l.delta ?? {} });
  editKey.value = null;
}

/* —— 时间 —— */
function editTime() {
  edit.timeStart = leaf.value?.timeStart ?? '';
  edit.timeEnd = leaf.value?.timeEnd ?? '';
  beginEdit('time');
}
function saveTime() {
  const l = leaf.value;
  if (!l) return;
  editLeafFull(props.floor, { text: l.text ?? '', timeStart: edit.timeStart, timeEnd: edit.timeEnd, delta: l.delta ?? {} });
  editKey.value = null;
}

/* —— 地点 —— */
function editLoc() {
  edit.location = d.value?.location ?? '';
  beginEdit('loc');
}
function saveLoc() {
  const loc = edit.location.trim();
  commitDelta(dd => {
    if (loc) dd.location = loc;
    else delete dd.location;
  });
}

// 当前正在编辑的角色 tag,本轮实际存在的字段(供模板按需渲染)。
// 关键:update delta 只含本轮改动的字段——若把全部字段都渲染成空框,用户会误以为「这角色没有这些数据」,
// 其实只是本轮没改。故只渲染 delta 里已存在(!== undefined)的字段;新增(add)则给全字段以便补全。
const npcEditFields = computed(() => {
  const key = editKey.value;
  if (!key || !key.startsWith('npc:')) return [];
  const [, bucket, idxStr] = key.split(':');
  if (bucket === 'remove') return [];
  const idx = Number(idxStr);
  const x = (bucket === 'add' ? d.value?.npcs?.add : d.value?.npcs?.update)?.[idx];
  if (!x) return [];
  // add 是新登场角色,允许补全所有字段;update 只暴露本轮已带的字段
  if (bucket === 'add') return NPC_FIELDS;
  const rec = x as unknown as Record<string, unknown>;
  return NPC_FIELDS.filter(f => rec[f.key] !== undefined);
});

/* —— 物品 / 角色 / 计划 就地改字段 —— */
function editTag(tag: Tag) {
  const dd = d.value;
  if (!dd) return;
  // 清空所有草稿字段:不可编辑的标签(scene / plan 的 resolve/reopen/remove)不会填任何字段,
  // 若不清空会残留上一次编辑的值(如刚编辑过物品,再点悬念「达成」就显示旧物品名)——这是串数据 bug 的根因。
  edit.name = '';
  edit.qty = '';
  edit.desc = '';
  edit.content = '';
  edit.title = '';
  edit.outfit = '';
  edit.condition = '';
  edit.npcDesc = '';
  edit.personality = '';
  edit.npcLoc = '';
  if (tag.key.startsWith('item:')) {
    if (tag.bucket === 'remove') {
      edit.name = dd.items?.remove?.[tag.idx] ?? '';
    } else {
      const x = (tag.bucket === 'add' ? dd.items?.add : dd.items?.update)?.[tag.idx];
      edit.name = x?.name ?? '';
      edit.qty = typeof x?.qty === 'number' ? String(x.qty) : '';
      edit.desc = x?.desc ?? '';
    }
  } else if (tag.key.startsWith('npc:')) {
    if (tag.bucket === 'remove') {
      edit.name = dd.npcs?.remove?.[tag.idx] ?? '';
    } else {
      const x = (tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update)?.[tag.idx];
      edit.name = x?.name ?? '';
      edit.title = x?.title ?? '';
      edit.outfit = x?.outfit ?? '';
      edit.condition = x?.condition ?? '';
      edit.npcDesc = x?.desc ?? '';
      edit.personality = x?.personality ?? '';
      edit.npcLoc = x?.location ?? '';
    }
  } else if (tag.key.startsWith('plan:add:')) {
    edit.content = dd.plans?.add?.[tag.idx]?.content ?? '';
  }
  beginEdit(tag.key);
}

function saveTag(tag: Tag) {
  commitDelta(dd => {
    if (tag.key.startsWith('item:')) {
      if (tag.bucket === 'remove') {
        if (dd.items?.remove) dd.items.remove[tag.idx] = edit.name.trim();
      } else {
        const arr = tag.bucket === 'add' ? dd.items?.add : dd.items?.update;
        const x = arr?.[tag.idx];
        if (x) {
          x.name = edit.name.trim();
          // String() 兜底:type="number" 的 v-model 会把值转成 number,直接 .trim() 会抛错(number 无 trim)。
          const qtyStr = String(edit.qty).trim();
          const q = Number(qtyStr);
          if (qtyStr && Number.isFinite(q)) x.qty = q;
          else delete x.qty;
          if (edit.desc.trim()) x.desc = edit.desc.trim();
          else delete x.desc;
        }
      }
    } else if (tag.key.startsWith('npc:')) {
      if (tag.bucket === 'remove') {
        if (dd.npcs?.remove) dd.npcs.remove[tag.idx] = edit.name.trim();
      } else {
        const arr = tag.bucket === 'add' ? dd.npcs?.add : dd.npcs?.update;
        const x = arr?.[tag.idx];
        if (x) {
          x.name = edit.name.trim();
          // 各档案/即时字段走注册表:有值即写、留空即删该键(空字段不落进 delta)。
          // 本轮未渲染的字段其草稿已被 editTag 清空 → 会 delete,但它本就不在 delta,无副作用。
          const rec = x as unknown as Record<string, unknown>;
          for (const f of NPC_FIELDS) {
            const t = (edit[f.draft] as string).trim();
            if (t) rec[f.key] = t;
            else delete rec[f.key];
          }
        }
      }
    } else if (tag.key.startsWith('plan:add:')) {
      const x = dd.plans?.add?.[tag.idx];
      if (x) x.content = edit.content.trim();
    }
  });
}

/** 删除某条变动(从对应桶按序号剔除)。 */
function deleteTag(tag: Tag) {
  const [cat, bucket] = tag.key.split(':');
  commitDelta(dd => {
    const group = (dd as Record<string, Record<string, unknown[]>>)[cat === 'item' ? 'items' : cat === 'npc' ? 'npcs' : cat === 'scene' ? 'scenes' : 'plans'];
    const arr = group?.[bucket];
    if (Array.isArray(arr)) arr.splice(tag.idx, 1);
  });
}

/* —— 整楼操作 —— */
// 删除摘要走行内两步确认(面板嵌在 #chat 滚动容器 + 每楼独立 shadow,行内比 Teleport 弹窗更稳、更贴合紧凑面板)
const confirmingDelete = ref(false);
function askDelete() {
  if (busy.value) return;
  confirmingDelete.value = true;
}
function cancelDelete() {
  confirmingDelete.value = false;
}
async function removeLeaf() {
  if (busy.value) return;
  busy.value = true;
  try {
    deleteLeafAt(props.floor);
    editKey.value = null;
    confirmingDelete.value = false;
  } finally {
    busy.value = false;
  }
}
// 收起抽屉 / 切换番外时,复位删除确认态,避免下次展开还停在确认中
watch([expanded, omit, leaf], () => {
  if (!expanded.value || omit.value || !leaf.value) confirmingDelete.value = false;
});
async function toggleOmit() {
  if (busy.value) return;
  busy.value = true;
  try {
    await setFloorOmit(props.floor, !omit.value);
  } finally {
    busy.value = false;
  }
}

// 分组渲染表(模板里循环用,减少重复)。icon 复用导航同款描边图标,给每个类目一个可辨识的视觉锚点。
const groups = computed(() => [
  { title: '物品', icon: 'items', tags: itemTags.value },
  { title: '角色', icon: 'npcs', tags: npcTags.value },
  { title: '场景', icon: 'scenes', tags: sceneTags.value },
  { title: '悬念簿', icon: 'plans', tags: planTags.value },
]);
</script>

<template>
  <div class="bbs-root bbs-fp" :data-theme="ui.theme">
    <article class="bbs-summary-card bbs-fp-card" :class="{ 'is-omit': omit, 'is-expanded': expanded }">
      <!-- 卡片头 = 锚点:两行。首行「楼号 + 时间」,次行摘要预览 -->
      <header class="bbs-fp-head" @click="expanded = !expanded">
        <span class="bbs-fp-head-main">
          <span class="bbs-fp-head-top">
            <span class="bbs-fp-floor" :class="{ 'is-pending': !omit && !valid, 'is-omit': omit }">#{{ floor }}</span>
            <span v-if="timeLabel" class="bbs-fp-head-time">🕑 {{ timeLabel }}</span>
          </span>
          <span class="bbs-fp-preview" :class="{ 'is-muted': previewMuted }">{{ previewText }}</span>
        </span>
        <button
          class="bbs-fp-omitbtn"
          :class="{ 'is-active': omit }"
          type="button"
          :title="omit ? '取消番外(恢复参与记忆)' : '标为番外(此楼不参与摘要/总结/注入)'"
          :disabled="busy"
          @click.stop="toggleOmit"
        >
          <Icon name="sparkles" />
        </button>
        <Icon name="chevron" class="bbs-fp-caret" :class="{ 'is-collapsed': !expanded }" />
      </header>

      <!-- 卡片体 = 抽屉(grid 高度过渡) -->
      <div class="bbs-fp-drawer" :class="{ 'is-open': expanded }">
        <div class="bbs-fp-drawer-inner">
          <div class="bbs-fp-drawer-body">
            <p v-if="omit" class="bbs-fp-note">此楼已标为番外,以下数据不参与记忆;取消番外即恢复。</p>

            <template v-if="leaf">
              <!-- 时间 / 地点 chips(可点编辑) -->
              <div class="bbs-fp-chips">
                <!-- 时间 -->
                <div v-if="editKey === 'time'" class="bbs-fp-editform">
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">起始</span>
                    <textarea :ref="setFocus" v-model="edit.timeStart" rows="1" class="bbs-input bbs-fp-nfield" placeholder="如 1988/9/29 21:00" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">结束</span>
                    <textarea v-model="edit.timeEnd" rows="1" class="bbs-input bbs-fp-nfield" placeholder="留空=同起始" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <div class="bbs-fp-editfoot">
                    <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
                    <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTime">保存</button>
                  </div>
                </div>
                <button v-else-if="!omit" class="bbs-fp-chip is-btn" type="button" @click="editTime">
                  🕑 {{ timeLabel || '设置时间' }}
                </button>
                <span v-else-if="timeLabel" class="bbs-fp-chip">🕑 {{ timeLabel }}</span>

                <!-- 地点 -->
                <div v-if="editKey === 'loc'" class="bbs-fp-editform">
                  <label class="bbs-fp-nrow">
                    <span class="bbs-fp-nlabel">地点</span>
                    <textarea :ref="setFocus" v-model="edit.location" rows="1" class="bbs-input bbs-fp-nfield" placeholder="当前地点" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                  </label>
                  <div class="bbs-fp-editfoot">
                    <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
                    <button class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveLoc">保存</button>
                  </div>
                </div>
                <button v-else-if="!omit" class="bbs-fp-chip is-btn" type="button" @click="editLoc">
                  📍 {{ d?.location || '设置地点' }}
                </button>
                <span v-else-if="d?.location" class="bbs-fp-chip">📍 {{ d.location }}</span>
              </div>

              <!-- 摘要正文(可点编辑) -->
              <template v-if="editKey === 'text'">
                <div class="bbs-fp-texteditor">
                  <textarea :ref="setFocus" v-model="edit.text" class="bbs-input bbs-fp-textarea" rows="3" @input="onTextInput"></textarea>
                  <div class="bbs-fp-editrow-actions">
                    <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
                    <button class="bbs-btn bbs-btn-primary" type="button" @click="saveText">保存</button>
                  </div>
                </div>
              </template>
              <p
                v-else
                class="bbs-summary-text bbs-fp-text"
                :class="{ 'is-muted': !leaf.text, 'is-btn': !omit }"
                :title="omit ? '' : '点击编辑摘要正文'"
                @click="!omit && editText()"
              >
                {{ leaf.text || '(无摘要正文,点此补写)' }}
              </p>

              <!-- 变动分组:每类目一张小卡(图标标题 + 标签流);点标签就地编辑(可编辑类)或展开删除 -->
              <div v-if="hasAnyDelta" class="bbs-fp-groups">
                <template v-for="g in groups" :key="g.title">
                <section v-if="g.tags.length" class="bbs-fp-group">
                  <span class="bbs-fp-gtitle"><Icon :name="g.icon" class="bbs-fp-gicon" />{{ g.title }}</span>
                  <div class="bbs-fp-flow">
                    <template v-for="tag in g.tags" :key="tag.key">
                      <!-- 就地编辑该标签:统一表单式(带字段标签 + 底部规整按钮)。可编辑类给字段行;
                           不可编辑类(scene、plan 的 达成/重启/删除)只读回显 + 删除/取消。 -->
                      <div v-if="editKey === tag.key" class="bbs-fp-editform">
                        <template v-if="tag.editable && tag.key.startsWith('item:') && tag.bucket !== 'remove'">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">名称</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">数量</span>
                            <input v-model="edit.qty" class="bbs-input bbs-fp-nfield bbs-fp-nfield-num" type="number" placeholder="留空=不计数" />
                          </label>
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">描述</span>
                            <textarea v-model="edit.desc" rows="1" class="bbs-input bbs-fp-nfield" placeholder="可选" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.key.startsWith('npc:') && tag.bucket !== 'remove'">
                          <!-- 名称恒有(匹配键);其余只渲染本轮实际改动过的字段,不误导「无此数据」 -->
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">名称</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                          <label v-for="f in npcEditFields" :key="f.draft" class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">{{ f.label }}</span>
                            <textarea v-model="edit[f.draft]" rows="1" class="bbs-input bbs-fp-nfield" :placeholder="f.label" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.key.startsWith('plan:add:')">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">内容</span>
                            <textarea :ref="setFocus" v-model="edit.content" rows="1" class="bbs-input bbs-fp-nfield" placeholder="内容" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <template v-else-if="tag.editable && tag.bucket === 'remove'">
                          <label class="bbs-fp-nrow">
                            <span class="bbs-fp-nlabel">名称</span>
                            <textarea :ref="setFocus" v-model="edit.name" rows="1" class="bbs-input bbs-fp-nfield" placeholder="名称" @input="onTextInput" @keydown="onFieldKeydown"></textarea>
                          </label>
                        </template>
                        <!-- 不可编辑标签:只读回显要删除的内容 -->
                        <p v-else class="bbs-fp-editreadonly">{{ tag.text }}</p>
                        <div class="bbs-fp-editfoot">
                          <button class="bbs-fp-editdel" type="button" title="删除此条" @click="deleteTag(tag)"><Icon name="trash" />删除</button>
                          <span class="bbs-fp-editfoot-spacer"></span>
                          <button class="bbs-btn bbs-btn-sm" type="button" @click="cancelEdit">取消</button>
                          <button v-if="tag.editable" class="bbs-btn bbs-btn-sm bbs-btn-primary" type="button" @click="saveTag(tag)">保存</button>
                        </div>
                      </div>
                      <!-- 标签只读态:徽标钉左上 + 主文本一行 + 副文本(细节)另起淡色一行 -->
                      <button
                        v-else
                        class="bbs-fp-tagline is-btn"
                        :class="'op-' + tag.op"
                        type="button"
                        :disabled="omit"
                        :title="omit ? '' : '点击编辑'"
                        @click="editTag(tag)"
                      >
                        <span class="bbs-fp-op">{{ opLabel[tag.op] }}</span>
                        <span class="bbs-fp-tagbody">
                          <span class="bbs-fp-tagmain">{{ tag.text }}</span>
                          <span v-if="tag.sub" class="bbs-fp-tagsub">{{ tag.sub }}</span>
                        </span>
                      </button>
                    </template>
                  </div>
                </section>
                </template>
              </div>
            </template>

            <p v-else class="bbs-summary-text bbs-fp-text is-muted">此楼尚无摘要。</p>

            <!-- 页脚:删除整楼摘要(行内两步确认,防误触) -->
            <div v-if="leaf && !omit" class="bbs-fp-footer">
              <template v-if="confirmingDelete">
                <span class="bbs-fp-confirm-text">删除此楼摘要?</span>
                <button class="bbs-fp-confirm-cancel" type="button" :disabled="busy" @click="cancelDelete">取消</button>
                <button class="bbs-fp-confirm-ok" type="button" :disabled="busy" @click="removeLeaf">
                  <Icon name="trash" />删除
                </button>
              </template>
              <button v-else class="bbs-fp-delleaf" type="button" title="删除此楼摘要" :disabled="busy" @click="askDelete">
                <Icon name="trash" />删除摘要
              </button>
            </div>
          </div>
        </div>
      </div>
    </article>
  </div>
</template>

<style scoped>
.bbs-fp {
  margin: 6px 0 2px;
}
/* 外层卡用 --bbs-bg(页面底色),与主界面「页面底 → surface 卡片 → surface-2 次级块」的
   层次一致:楼层面板即一块「迷你页面」,内部的类目小卡才是抬起的 surface。
   (默认继承自 .bbs-summary-card 的 surface,这里覆盖成 bg。)
   收起态更紧凑:收窄内边距,楼号行本就矮,大留白会显空。展开态恢复常规 padding。 */
.bbs-fp-card {
  background: var(--bbs-bg);
  padding: 9px 12px;
}
.bbs-fp-card.is-expanded {
  padding: 12px 14px;
}
.bbs-fp-card.is-omit {
  opacity: 0.72;
  border-left: 3px solid var(--bbs-ink-muted);
}

/* 卡片头:左侧两行主区(楼号+时间 / 预览)+ 右侧番外键、箭头 */
.bbs-fp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex-wrap: nowrap;
}
.bbs-fp-head-main {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
/* 首行:楼号 + 时间 */
.bbs-fp-head-top {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.bbs-fp-head-time {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
  font-variant-numeric: tabular-nums;
}
/* 楼号做成药丸,与主界面摘要卡的 #楼层 标签同款——面板一眼就与主界面同源 */
.bbs-fp-floor {
  flex: 0 0 auto;
  box-sizing: border-box;
  height: 20px;
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-accent);
  background: var(--bbs-accent-soft);
  font-family: var(--bbs-font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
/* 待摘/番外:退成中性描边,不抢强调色 */
.bbs-fp-floor.is-pending,
.bbs-fp-floor.is-omit {
  color: var(--bbs-ink-muted);
  border-color: var(--bbs-line);
  background: var(--bbs-surface-2);
}
.bbs-fp-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  color: var(--bbs-ink-soft);
}
.bbs-fp-preview.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-fp-omitbtn {
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
  cursor: pointer;
  font-size: 13px;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-omitbtn:hover {
  color: var(--bbs-accent);
  background: var(--bbs-surface-2);
}
.bbs-fp-omitbtn.is-active {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-fp-caret {
  flex: 0 0 auto;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-caret.is-collapsed {
  transform: rotate(-90deg);
}
.bbs-fp-card.is-expanded .bbs-fp-head {
  margin-bottom: 12px;
}

/* 抽屉 */
.bbs-fp-drawer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open {
  grid-template-rows: 1fr;
}
.bbs-fp-drawer-inner {
  min-height: 0;
  overflow: hidden;
}
.bbs-fp-drawer-body {
  opacity: 0;
  transform: translateY(-8px);
  transition:
    opacity var(--bbs-dur) var(--bbs-ease),
    transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-drawer.is-open .bbs-fp-drawer-body {
  opacity: 1;
  transform: none;
}

.bbs-fp-note {
  margin: 0 0 10px;
  padding: 6px 10px;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
  font-size: 12px;
}

/* 时间/地点 chips */
.bbs-fp-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
}
.bbs-fp-chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 10px;
  border-radius: var(--bbs-radius-pill);
  border: 1px solid transparent;
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
  font-size: 11.5px;
  font-weight: 500;
}
.bbs-fp-chip.is-btn {
  cursor: pointer;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-chip.is-btn:hover {
  border-color: var(--bbs-accent);
}

/* 正文:只读块与编辑 textarea 共用同一盒模型(消除切换跳动)。
   关键——两者 font-size / line-height / padding / border 必须完全一致,只差背景/可编辑。 */
.bbs-fp-text,
.bbs-fp-textarea {
  box-sizing: border-box;
  display: block;
  width: 100%;
  margin: 0 0 10px;
  padding: 9px 11px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  font-family: var(--bbs-font-sans);
  font-size: 13px;
  line-height: 1.75;
  letter-spacing: 0.02em;
  color: var(--bbs-ink);
  white-space: pre-wrap;
  word-break: break-word;
}
/* 只读态:抬起面(surface)像一枚静置的字段浮在 bg 外层卡上,悬停点亮强调边提示「可编辑」 */
.bbs-fp-text {
  background: var(--bbs-surface);
}
.bbs-fp-text.is-muted {
  color: var(--bbs-ink-muted);
  font-style: italic;
}
.bbs-fp-text.is-btn {
  cursor: text;
  transition: border-color var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-text.is-btn:hover {
  border-color: var(--bbs-accent);
}

/* 变动分组:整体不再是平铺行,而是若干张「卡中卡」——每类目一张淡底描边小卡,
   顶部图标标题定调,下方标签流。层次感与主界面卡片语言一致。 */
.bbs-fp-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 12px;
  border-top: 1px dashed var(--bbs-line);
}
/* 类目小卡:抬起面(surface),浮在 bg 外层卡之上——对齐主界面 .bbs-plan 卡片 */
.bbs-fp-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface);
}
/* 类目标题:描边图标 + 名称,图标着强调色作视觉锚点,一眼分区 */
.bbs-fp-gtitle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bbs-ink-soft);
  white-space: nowrap;
}
.bbs-fp-gicon {
  color: var(--bbs-accent);
  font-size: 15px;
}
/* 变动条纵向堆叠(每条独占一行):它们承载的是可长可短的内容,横向 chip 流会把长条撑成
   丑陋的多行泡泡。改为账册式条目——一行一条、左对齐、内容自然换行。 */
.bbs-fp-flow {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
/* 变动条(只读=按钮,可点编辑):徽标钉左上,右侧主/副文本左对齐。
   坐落在 surface 类目卡上,故自身用次级面(surface-2),层次沉一档;
   小圆角(非药丸),像账册上的一行条目;色彩只落在左侧徽标,条目本体素净。 */
.bbs-fp-tagline {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-line);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
  font-family: var(--bbs-font-sans);
  text-align: left;
}
.bbs-fp-tagline.is-btn {
  cursor: pointer;
  transition:
    border-color var(--bbs-dur) var(--bbs-ease),
    box-shadow var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-tagline.is-btn:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  box-shadow: 0 0 0 2px var(--bbs-accent-soft);
}
.bbs-fp-tagline:disabled {
  cursor: default;
}
/* op 徽标:小圆角色块,颜色即语义(新增=强调、移除=危险、达成/重启=琥珀、更新/迁移=中性)。
   中性态在 surface-2 条上用 surface 提亮一档;顶部对齐首行,margin-top 微调与主文本基线齐平。 */
.bbs-fp-op {
  flex: 0 0 auto;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-sm);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--bbs-ink-soft);
  background: var(--bbs-surface);
}
.bbs-fp-tagline.op-add .bbs-fp-op {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-fp-tagline.op-remove .bbs-fp-op {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-fp-tagline.op-resolve .bbs-fp-op,
.bbs-fp-tagline.op-reopen .bbs-fp-op {
  color: var(--bbs-warning);
  background: var(--bbs-warning-soft);
}
/* 主/副文本:纵向堆叠,主文本正常色、副文本淡色小字 */
.bbs-fp-tagbody {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.bbs-fp-tagmain {
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-fp-tagsub {
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}

/* ===== 统一就地编辑表单 =====
   时间/地点/物品/角色/悬念的编辑全走这套:淡底描边卡片,内含「字段行(标签+输入)」
   纵向排列,底部一条规整的删除/取消/保存。观感对齐主界面弹窗,不再是挤成一行的小框。 */
.bbs-fp-editform {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: var(--bbs-radius-sm);
  border: 1px solid var(--bbs-accent);
  background: var(--bbs-surface);
}
/* 字段行:左侧固定宽标签 + 右侧撑满输入框,规整对齐 */
/* 字段行:标签顶端对齐(输入框可能多行,标签仍贴首行) */
.bbs-fp-nrow {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.bbs-fp-nlabel {
  flex: 0 0 auto;
  width: 40px;
  padding-top: 6px; /* 与字段首行文字基线对齐 */
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
/* 字段输入:改用 textarea 以「单行输入、多行显示」——内容长时自动换行、随内容长高,
   完整可见;回车被 onFieldKeydown 拦截,输入语义仍是单行。
   底用 surface-2:输入框在 surface 表单卡上要沉一档,对齐主界面输入框惯例。 */
.bbs-fp-nfield {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 9px;
  font-size: 12.5px;
  font-family: var(--bbs-font-sans);
  line-height: 1.5;
  background: var(--bbs-surface-2);
  resize: none;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
/* 数量仍是普通 number input,单行即可,不需要换行长高 */
.bbs-fp-nfield-num {
  resize: none;
}
/* 不可编辑标签删除态:只读回显要删除的内容 */
.bbs-fp-editreadonly {
  margin: 0;
  font-size: 12.5px;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
/* 底部操作条:删除靠左(低调,hover 显红),取消/保存靠右成组 */
.bbs-fp-editfoot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
}
.bbs-fp-editfoot-spacer {
  flex: 1 1 auto;
}
.bbs-fp-editfoot .bbs-btn-sm {
  padding: 5px 12px;
  font-size: 12px;
}
.bbs-fp-editdel {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-editdel:hover {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}

/* 正文编辑器:textarea 盒模型已与只读块统一(见上「正文」块),这里只加可拉伸 + 去掉底距(编辑器容器管间距) */
.bbs-fp-texteditor {
  margin-bottom: 10px;
}
.bbs-fp-textarea {
  resize: vertical;
  margin: 0;
  /* autosize 用 JS 按 scrollHeight 设高;隐藏滚动条避免拉高瞬间闪现,给个下限防空文本过扁 */
  min-height: 64px;
  overflow: hidden;
}
.bbs-fp-editrow-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}

/* 页脚 */
.bbs-fp-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--bbs-line);
}
/* 删除入口:平时只是一枚安静的图标+字,靠右不抢眼;hover 才浮现危险色 */
.bbs-fp-delleaf {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-delleaf:hover:not(:disabled) {
  color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
.bbs-fp-delleaf:disabled {
  opacity: 0.55;
  cursor: default;
}
/* 两步确认:提示文字 + 取消/删除并排,删除键用危险色实心,确认动作明确 */
.bbs-fp-confirm-text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
.bbs-fp-confirm-cancel,
.bbs-fp-confirm-ok {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: var(--bbs-radius-sm);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    border-color var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fp-confirm-cancel {
  border: 1px solid var(--bbs-line-strong);
  background: transparent;
  color: var(--bbs-ink-soft);
}
.bbs-fp-confirm-cancel:hover:not(:disabled) {
  border-color: var(--bbs-accent);
  color: var(--bbs-accent);
}
.bbs-fp-confirm-ok {
  border: 1px solid var(--bbs-danger);
  background: var(--bbs-danger);
  color: #fff;
}
.bbs-fp-confirm-ok:hover:not(:disabled) {
  opacity: 0.9;
}
.bbs-fp-confirm-cancel:disabled,
.bbs-fp-confirm-ok:disabled {
  opacity: 0.55;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .bbs-fp-drawer,
  .bbs-fp-drawer-body,
  .bbs-fp-caret {
    transition: none;
  }
}
</style>
