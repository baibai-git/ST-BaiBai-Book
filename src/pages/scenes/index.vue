<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import ModalMask from '@/components/ModalMask.vue';
import { editSceneDesc, findCurrentSceneId, removeScene, reparentScene, upsertScene } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { getContext } from '@/st/context';
import type { MemScene } from '@/memory/types';
import { computed, nextTick, ref, watch } from 'vue';

// 场景是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* —— 折叠状态:纯本机 UI 态,按聊天分桶存 localStorage(切走再回保持) —— */
const COLLAPSE_KEY = 'bbs.scenes.collapsed.v1';
function chatKey(): string {
  return getContext()?.getCurrentChatId?.() || '_';
}
function loadCollapsed(): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    return new Set<string>(Array.isArray(all[chatKey()]) ? all[chatKey()] : []);
  } catch {
    return new Set();
  }
}
// 折叠的节点 id 集合(响应式);默认全展开
const collapsed = ref<Set<string>>(loadCollapsed());
function persistCollapsed() {
  try {
    const all = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}');
    all[chatKey()] = [...collapsed.value];
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage 不可用时静默 */
  }
}
function toggleCollapse(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next; // 换引用触发响应式
  persistCollapsed();
}

/* —— 把扁平 scenes 按 parentId 组装成嵌套树,深度优先展平成带 depth 的可渲染行 —— */
interface SceneRow {
  node: MemScene;
  depth: number;
  /** 该行是否在「当前所在」的祖先脉络上(根→当前地点) */
  onCurrentPath: boolean;
  /** 是否就是当前所在地点本身 */
  isCurrent: boolean;
  /** 同级里是否最后一个(画引导线收尾用) */
  lastChild: boolean;
  /** 是否有子节点(决定是否显示折叠箭头) */
  hasChildren: boolean;
  /** 当前是否处于折叠态(子树已收起) */
  isCollapsed: boolean;
}

// 当前所在节点:与注入端共用 apply.findCurrentSceneId(优先权威 locationPath,否则收紧模糊匹配)。
// 单一来源,保证场景页高亮 = 提示词里「当前所在」链,不再分叉。
const currentId = computed(() =>
  findCurrentSceneId(memory.scenes, memory.state.location || '', memory.state.locationPath),
);

// 当前所在的祖先脉络(含自身)id 集合
const currentChain = computed(() => {
  const ids = new Set<string>();
  const byId = new Map(memory.scenes.map(s => [s.id, s]));
  let cur = byId.get(currentId.value);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ids.add(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return ids;
});

// 所在地点变化时,自动展开新脉络一次(避免「我在哪」被折叠藏起);但只在 currentId 真的
// 变了时触发,之后用户仍能手动折叠该脉络——这正是和旧「强制展开」的关键区别。
watch(
  () => currentId.value,
  () => {
    const next = new Set(collapsed.value);
    let changed = false;
    for (const cid of currentChain.value) {
      if (next.delete(cid)) changed = true;
    }
    if (changed) {
      collapsed.value = next;
      persistCollapsed();
    }
  },
);

function match(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

const rows = computed<SceneRow[]>(() => {
  const byParent = new Map<string, MemScene[]>();
  for (const s of memory.scenes) {
    const arr = byParent.get(s.parentId) ?? [];
    arr.push(s);
    byParent.set(s.parentId, arr);
  }
  for (const arr of byParent.values()) {
    // 同级:当前脉络上的排前(让活动主干稳定靠上),再按创建序
    arr.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }
  const out: SceneRow[] = [];
  const walk = (parentId: string, depth: number) => {
    const children = byParent.get(parentId) ?? [];
    children.forEach((node, i) => {
      const kids = byParent.get(node.id) ?? [];
      // onCurrentPath 仅用于主干线高亮;折叠完全由用户的 collapsed 决定(不再强制展开,
      // 否则「所在」脉络上的行点了收不起来)。脉络变化时由 watch 自动展开一次,见下方。
      const onCurrentPath = currentChain.value.has(node.id);
      const isCollapsed = kids.length > 0 && collapsed.value.has(node.id);
      out.push({
        node,
        depth,
        onCurrentPath,
        isCurrent: node.id === currentId.value,
        lastChild: i === children.length - 1,
        hasChildren: kids.length > 0,
        isCollapsed,
      });
      if (!isCollapsed) walk(node.id, depth + 1); // 折叠则跳过整段子树
    });
  };
  walk('', 0); // 根 = parentId 为空
  return out;
});

// 存放在某地点的物品(location 包含式匹配该节点名/路径任一段;只读联动展示)
function itemsAt(node: MemScene) {
  return memory.items.filter(i => {
    if (i.carried !== false || !i.location) return false;
    return match(i.location, node.name) || node.path.some(seg => match(i.location!, seg));
  });
}

// 折叠时展示的后代地点数(整段子树,id 前缀匹配)
function childCount(node: MemScene): string {
  const prefix = `${node.id}/`;
  const n = memory.scenes.filter(s => s.id.startsWith(prefix)).length;
  return n ? `+${n}` : '';
}

/** 上级地点下拉选项:全部节点按完整路径排序(父先于子),depth 决定缩进前缀。不受折叠影响。 */
const sceneOptions = computed(() =>
  [...memory.scenes]
    .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')))
    .map(s => ({ id: s.id, name: s.name, depth: s.path.length - 1 })),
);

/* —— 新增地点(弹窗):选上级(已有路径 / 顶级)+ 填新名 + 描述 —— */
const composerOpen = ref(false);
const newParentId = ref(''); // 选中的上级 id;'' = 顶级
const newName = ref('');
const newDesc = ref('');
const nameInput = ref<HTMLInputElement | null>(null);

function openComposer() {
  if (!hasLeaf.value) return;
  newParentId.value = currentId.value || ''; // 默认挂在当前所在地点下,顺手
  newName.value = '';
  newDesc.value = '';
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addScene() {
  const name = newName.value.trim();
  // 描述必填:写不出描述的地点不记(与 AI 同规则)
  if (!name || !newDesc.value.trim()) return;
  const parent = memory.scenes.find(s => s.id === newParentId.value);
  const path = parent ? [...parent.path, name] : [name];
  if (!upsertScene(path, newDesc.value)) return;
  composerOpen.value = false;
}

/* —— 编辑弹窗:改本级名 + 上级(下拉选)+ 描述 —— */
interface SceneEditing {
  id: string; // 原始节点 id
  path: string[]; // 原始完整路径
  name: string;
  parentId: string; // 选中的上级 id;'' = 顶级
  desc: string;
}
const editing = ref<SceneEditing | null>(null);

function openEdit(node: MemScene) {
  editing.value = {
    id: node.id,
    path: node.path,
    name: node.name,
    parentId: node.parentId,
    desc: node.desc ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}

/** 编辑态下的可选上级:排除节点自身及其后代(否则会把节点变成自己的祖先,成环)。 */
const editParentOptions = computed(() => {
  const e = editing.value;
  if (!e) return sceneOptions.value;
  const selfPrefix = `${e.id}/`;
  return sceneOptions.value.filter(o => o.id !== e.id && !o.id.startsWith(selfPrefix));
});

function saveEdit() {
  const e = editing.value;
  const name = e?.name.trim();
  if (!e || !name || !e.desc.trim()) return; // 描述必填
  const parent = memory.scenes.find(s => s.id === e.parentId);
  const newPath = parent ? [...parent.path, name] : [name];
  const pathChanged = newPath.join('/') !== e.path.join('/');

  if (pathChanged) {
    // 换父 / 改名 / 插层:一条 reparent 原子完成,连子树平移 + 顺带写新名描述
    reparentScene(e.path, newPath, { [name]: e.desc.trim() });
  } else {
    editSceneDesc(e.path, e.desc);
  }
  editing.value = null;
}

/* —— 删除确认(连带子级)—— */
const removing = ref<MemScene | null>(null);
function askRemove(node: MemScene) {
  removing.value = node;
}
function confirmRemove() {
  if (removing.value) removeScene(removing.value.path);
  removing.value = null;
}
const removeChildCount = computed(() => {
  const n = removing.value;
  if (!n) return 0;
  const prefix = `${n.id}/`;
  return memory.scenes.filter(s => s.id.startsWith(prefix)).length;
});
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">场景</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? '手动添加地点' : '需先有摘要才能手动添加'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>

    <hr class="bbs-rule" />

    <TransitionGroup v-if="rows.length" tag="div" name="scene" class="bbs-scene-tree">
      <div
        v-for="r in rows"
        :key="r.node.id"
        class="bbs-scene-row"
        :class="{ 'is-current': r.isCurrent, 'on-path': r.onCurrentPath }"
        :style="{ '--depth': r.depth }"
      >
        <!-- 层级引导轨:每级一条细竖线,在当前脉络上点亮成主干 -->
        <span v-for="d in r.depth" :key="d" class="bbs-scene-rail" :class="{ active: r.onCurrentPath && d <= r.depth }"></span>

        <!-- 有子节点的整张卡片可点折叠(含描述/物品区);叶子卡不可点。操作按钮 @click.stop 不触发 -->
        <div
          class="bbs-scene-card"
          :class="{ clickable: r.hasChildren }"
          @click="r.hasChildren && toggleCollapse(r.node.id)"
        >
          <div class="bbs-scene-head">
            <span
              v-if="r.hasChildren"
              class="bbs-scene-toggle"
              :class="{ collapsed: r.isCollapsed }"
              :title="r.isCollapsed ? '展开下属地点' : '收起下属地点'"
            >
              <Icon name="chevron" />
            </span>
            <span class="bbs-scene-name">{{ r.node.name }}</span>
            <span v-if="r.isCurrent" class="bbs-scene-here"><Icon name="scenes" />所在</span>
            <span v-else-if="r.isCollapsed" class="bbs-scene-count">{{ childCount(r.node) }}</span>
            <span class="bbs-scene-acts">
              <button class="bbs-item-act" type="button" title="编辑" @click.stop="openEdit(r.node)"><Icon name="edit" /></button>
              <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click.stop="askRemove(r.node)"><Icon name="trash" /></button>
            </span>
          </div>
          <p v-if="r.node.desc" class="bbs-scene-desc">{{ r.node.desc }}</p>
          <div v-if="itemsAt(r.node).length" class="bbs-scene-items">
            <span v-for="it in itemsAt(r.node)" :key="it.id" class="bbs-scene-chip">
              <Icon name="items" />{{ it.name }}<i v-if="typeof it.qty === 'number'">×{{ it.qty }}</i>
            </span>
          </div>
        </div>
      </div>
    </TransitionGroup>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="scenes" /></span>
      <p>还没有去过的地点。摘要时会记下走过的场景,也可点右上角「+」手动添加。</p>
    </div>

    <!-- 添加弹窗:选上级(已有地点 / 顶级)+ 填新名 + 描述 -->
    <ModalMask v-if="composerOpen" @close="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加地点">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加地点</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">上级地点(从已有地点里选,或设为顶级)</span>
          <select v-model="newParentId" class="bbs-input">
            <option value="">（顶级地点）</option>
            <option v-for="o in sceneOptions" :key="o.id" :value="o.id">
              {{ '　'.repeat(o.depth) }}{{ o.name }}
            </option>
          </select>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名称</span>
          <input ref="nameInput" v-model="newName" class="bbs-input" type="text" placeholder="新地点名" @keydown.enter="addScene" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述(必填)</span>
          <textarea v-model="newDesc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="这地方是什么、有何特征"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!newName.trim() || !newDesc.trim()" @click="addScene">添加</button>
        </footer>
      </div>
    </ModalMask>

    <!-- 编辑弹窗:Teleport 出滚动容器,见 ModalMask -->
    <ModalMask v-if="editing" @close="cancelEdit">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑地点">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑地点</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <p class="bbs-scene-crumb">{{ editing.path.join(' › ') }}</p>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名称</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="地点名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">上级地点(改这里会连同下属一起移动)</span>
          <select v-model="editing.parentId" class="bbs-input">
            <option value="">（顶级地点）</option>
            <option v-for="o in editParentOptions" :key="o.id" :value="o.id">
              {{ '　'.repeat(o.depth) }}{{ o.name }}
            </option>
          </select>
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述(必填)</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="这地方是什么、有何特征"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim() || !editing.desc.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>

    <ConfirmDialog
      :open="!!removing"
      title="删除地点"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」<template v-if="removeChildCount">,及其下属 {{ removeChildCount }} 个地点</template>。此操作写入最新摘要,删除楼层可回退。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

/* —— 嵌套树:层级引导轨是这页的标识元素 —— */
.bbs-scene-tree {
  display: flex;
  flex-direction: column;
  gap: 6px;
  position: relative; /* 作离场行 position:absolute 的定位上下文 */
}
.bbs-scene-row {
  display: flex;
  align-items: stretch;
}

/* 展开/收起动画:进出淡入淡出 + 轻微上滑;留下的行用 move 平滑补位。
   用比 --bbs-dur(0.28s) 更快的 0.16s,折叠交互要干脆。 */
.scene-enter-active,
.scene-leave-active {
  transition: opacity 0.16s var(--bbs-ease), transform 0.16s var(--bbs-ease);
}
.scene-enter-from,
.scene-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
/* 离场的行脱离文档流,避免它占位导致下方行不平滑补位 */
.scene-leave-active {
  position: absolute;
  width: 100%;
}
.scene-move {
  transition: transform 0.16s var(--bbs-ease);
}
/* 每级一条 14px 宽的轨道槽,中间一条 hairline 竖线 */
.bbs-scene-rail {
  flex: 0 0 14px;
  position: relative;
}
.bbs-scene-rail::before {
  content: '';
  position: absolute;
  left: 6px;
  top: -6px; /* 接上一行的间隙,连成贯穿线 */
  bottom: -6px;
  width: 1px;
  background: var(--bbs-line);
}
/* 当前所在脉络:轨道点亮成主干 */
.bbs-scene-rail.active::before {
  background: var(--bbs-accent);
  opacity: 0.55;
  width: 2px;
  left: 5px;
}

.bbs-scene-card {
  flex: 1 1 auto;
  min-width: 0;
  padding: 9px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  transition: border-color var(--bbs-dur) var(--bbs-ease), background var(--bbs-dur) var(--bbs-ease);
}
/* 当前所在地点本身:实心强调,作脉络的终点 */
.bbs-scene-row.is-current .bbs-scene-card {
  border-color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-scene-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* 有子节点的卡片:整卡可点折叠,光标提示 + hover 时箭头变深 */
.bbs-scene-card.clickable {
  cursor: pointer;
}
.bbs-scene-card.clickable:hover .bbs-scene-toggle {
  color: var(--bbs-ink);
}
/* 折叠箭头:展开时朝下(chevron 原样),折叠时朝右(-90°)。纯视觉指示,点击由整行承接。 */
.bbs-scene-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  margin-right: -2px;
  color: var(--bbs-ink-muted);
  font-size: 13px;
  transition: transform 0.16s var(--bbs-ease), color var(--bbs-dur) var(--bbs-ease);
}
.bbs-scene-toggle.collapsed {
  transform: rotate(-90deg);
}
/* 折叠态:显示隐藏的后代数 */
.bbs-scene-count {
  flex: 0 0 auto;
  font-size: 11px;
  font-family: var(--bbs-font-mono);
  color: var(--bbs-ink-muted);
  padding: 0 6px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
}
.bbs-scene-name {
  font-family: var(--bbs-font-mono);
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bbs-scene-here {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 7px 1px 5px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
  letter-spacing: 0.02em;
}
.bbs-scene-acts {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: 0 0 auto;
}
.bbs-scene-desc {
  margin: 5px 0 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbs-ink-soft);
}
.bbs-scene-items {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 7px;
}
.bbs-scene-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-scene-chip i {
  font-style: normal;
  color: var(--bbs-accent);
}

/* 编辑弹窗里的路径面包屑 */
.bbs-scene-crumb {
  margin: 0 0 2px;
  font-family: var(--bbs-font-mono);
  font-size: 12px;
  color: var(--bbs-ink-muted);
}

/* 复用 items 页的行内操作按钮样式(scoped 不继承,这里重声明同款) */
.bbs-item-act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 14px;
}
.bbs-item-act:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-item-del:hover {
  color: var(--bbs-danger);
}
.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
.bbs-empty {
  flex: 1;
}
</style>
