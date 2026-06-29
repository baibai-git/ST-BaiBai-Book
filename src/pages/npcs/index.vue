<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ConfirmDialog from '@/components/ConfirmDialog.vue';
import { editNpc, removeNpc, setNpcFollow, upsertNpc } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import type { MemNpc, MemScene } from '@/memory/types';
import { computed, nextTick, ref } from 'vue';

// NPC 是从叶子摘要重放出的派生数据,手动操作写入「最新一条有效叶子」;无有效叶子时无处挂载。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

// 触屏判定:跳过弹窗自动聚焦(移动端自动聚焦会弹输入法挡界面),与场景/摘要页一致。
const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(hover: none)').matches;

/* —— 在场判定:复刻注入端 inject.ts 的口径,确保「界面显示的 = AI 收到的」 ——
   随行(follow)永远在场;否则按 location 与「当前地点 + 祖先链」包含式可达。 */
function match(a: string | undefined, b: string): boolean {
  const x = (a ?? '').trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x.includes(y) || y.includes(x);
}

// 当前所在场景节点(与场景页 / 注入端 findCurrentScene 同口径:包含式匹配、取最深)
const currentScene = computed<MemScene | null>(() => {
  const here = (memory.state.location || '').trim();
  if (!here) return null;
  let best: MemScene | null = null;
  for (const s of memory.scenes) {
    const hit = match(s.name, here) || s.path.some(seg => match(seg, here));
    if (hit && (!best || s.path.length > best.path.length)) best = s;
  }
  return best;
});

// 当前所在地点 + 其祖先链的「可匹配名」集合(本级名 + 完整路径拼接),供 NPC location 比对
const reachableNames = computed<string[]>(() => {
  const names: string[] = [];
  const here = (memory.state.location || '').trim();
  if (here) names.push(here);
  const byId = new Map(memory.scenes.map(s => [s.id, s]));
  let cur = currentScene.value;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    names.push(cur.name, cur.path.join(''));
    cur = cur.parentId ? byId.get(cur.parentId) ?? null : null;
  }
  return names;
});

function onScene(npc: MemNpc): boolean {
  if (npc.follow === true) return true;
  const loc = (npc.location ?? '').trim();
  if (!loc) return false;
  // 无场景数据时退回纯当前地点字符串比对(与注入端 itemReachableInScene 的兜底一致)
  if (!reachableNames.value.length) return false;
  return reachableNames.value.some(n => match(loc, n));
}

// 分两组:在场(随行/所在地可达)与不在场。各自按创建序稳定排列。
const present = computed(() =>
  memory.npcs.filter(onScene).sort((a, b) => a.createdAt - b.createdAt),
);
const absent = computed(() =>
  memory.npcs.filter(n => !onScene(n)).sort((a, b) => a.createdAt - b.createdAt),
);

// 首字徽记:取名字第一个字符(中英皆可)作肖像替身
function monogram(name: string): string {
  return [...name.trim()][0] ?? '?';
}

/* —— 随行一键开关:随行→取消(留在当前地点);非随行→标记随行 —— */
function toggleFollow(npc: MemNpc) {
  if (npc.follow === true) {
    // 取消随行:留在当前所在地(无则留空,成为无位置的游离 NPC)
    setNpcFollow(npc.name, false, memory.state.location || '');
  } else {
    setNpcFollow(npc.name, true);
  }
}

function askRemove(npc: MemNpc) {
  removing.value = npc;
}

/* —— 新增弹窗 —— */
const composerOpen = ref(false);
const nameInput = ref<HTMLInputElement | null>(null);
interface NpcDraft {
  name: string;
  title: string;
  personality: string;
  desc: string;
  follow: boolean;
  location: string;
}
function emptyDraft(): NpcDraft {
  return { name: '', title: '', personality: '', desc: '', follow: false, location: memory.state.location || '' };
}
const draft = ref<NpcDraft>(emptyDraft());

function openComposer() {
  if (!hasLeaf.value) return;
  draft.value = emptyDraft();
  composerOpen.value = true;
  if (!isTouch) void nextTick(() => nameInput.value?.focus());
}
function closeComposer() {
  composerOpen.value = false;
}
function addNpc() {
  const d = draft.value;
  if (!d.name.trim()) return;
  const ok = upsertNpc({
    name: d.name,
    title: d.title,
    personality: d.personality,
    desc: d.desc,
    follow: d.follow,
    location: d.follow ? '' : d.location,
  });
  if (!ok) return;
  composerOpen.value = false;
}

/* —— 编辑弹窗 —— */
interface NpcEditing extends NpcDraft {
  oldName: string;
}
const editing = ref<NpcEditing | null>(null);

function openEdit(npc: MemNpc) {
  editing.value = {
    oldName: npc.name,
    name: npc.name,
    title: npc.title ?? '',
    personality: npc.personality ?? '',
    desc: npc.desc ?? '',
    follow: npc.follow === true,
    location: npc.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  editNpc(e.oldName, {
    name: e.name,
    title: e.title,
    personality: e.personality,
    desc: e.desc,
    follow: e.follow,
    location: e.follow ? '' : e.location,
  });
  editing.value = null;
}

/* —— 删除确认 —— */
const removing = ref<MemNpc | null>(null);
function confirmRemove() {
  if (removing.value) removeNpc(removing.value.name);
  removing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-section-head">
      <h2 class="bbs-title bbs-title-sub">角色</h2>
      <button
        class="bbs-add-mini"
        type="button"
        :disabled="!hasLeaf"
        :title="hasLeaf ? '手动添加角色' : '需先有摘要才能手动添加'"
        @click="openComposer"
      >
        <Icon name="plus" />
      </button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="memory.npcs.length" class="bbs-npc-groups">
      <!-- 在场:随行 / 所在当前场景。全量信息发给 AI,这里也全量展示 -->
      <div v-if="present.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag is-present">在场</span>
          <span class="bbs-npc-grouphint">完整信息随剧情发送</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in present" :key="n.id" class="bbs-npc is-present">
            <span class="bbs-npc-disc" :class="{ 'is-follow': n.follow }">{{ monogram(n.name) }}</span>
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.title" class="bbs-npc-title">{{ n.title }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    :class="{ active: n.follow }"
                    type="button"
                    :title="n.follow ? '随行中 · 点击取消(留在当前地点)' : '标记为随行同伴'"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <div class="bbs-npc-meta">
                <span v-if="n.follow" class="bbs-npc-flag is-follow"><Icon name="pin" />随行</span>
                <span v-else-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
              </div>
              <p v-if="n.personality" class="bbs-npc-trait">{{ n.personality }}</p>
              <p v-if="n.desc" class="bbs-npc-desc">{{ n.desc }}</p>
            </div>
          </article>
        </div>
      </div>

      <!-- 不在场:只发名+身份给 AI,这里也压暗、收起细节 -->
      <div v-if="absent.length" class="bbs-npc-group">
        <div class="bbs-npc-grouphead">
          <span class="bbs-npc-grouptag">不在场</span>
          <span class="bbs-npc-grouphint">仅发送名字与身份,省 token</span>
        </div>
        <div class="bbs-npc-list">
          <article v-for="n in absent" :key="n.id" class="bbs-npc is-absent">
            <span class="bbs-npc-disc">{{ monogram(n.name) }}</span>
            <div class="bbs-npc-body">
              <div class="bbs-npc-head">
                <span class="bbs-npc-name">{{ n.name }}</span>
                <span v-if="n.title" class="bbs-npc-title">{{ n.title }}</span>
                <span class="bbs-npc-acts">
                  <button
                    class="bbs-item-act bbs-npc-pin"
                    type="button"
                    title="标记为随行同伴(将随主角在场)"
                    @click="toggleFollow(n)"
                  >
                    <Icon name="pin" />
                  </button>
                  <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(n)"><Icon name="edit" /></button>
                  <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="askRemove(n)"><Icon name="trash" /></button>
                </span>
              </div>
              <div class="bbs-npc-meta">
                <span v-if="n.location" class="bbs-npc-flag"><Icon name="scenes" />{{ n.location }}</span>
                <span v-else class="bbs-npc-flag is-nowhere">所在不明</span>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="npcs" /></span>
      <p>还没有登场的角色。摘要时会记下与主角有交集的人物,也可点右上角「+」手动添加。</p>
    </div>

    <!-- 添加弹窗:position:fixed 内联(不用 Teleport,见 base.css 说明) -->
    <div v-if="composerOpen" class="bbs-modal-mask" @click.self="closeComposer">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="添加角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">添加角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="closeComposer"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input ref="nameInput" v-model="draft.name" class="bbs-input" type="text" placeholder="角色名" @keydown.enter="addNpc" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <input v-model="draft.title" class="bbs-input" type="text" placeholder="如:归雁客栈掌柜、青梅竹马" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <input v-model="draft.personality" class="bbs-input" type="text" placeholder="如:沉默寡言、护短" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述</span>
          <textarea v-model="draft.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="draft.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!draft.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点</span>
          <input v-model="draft.location" class="bbs-input" type="text" placeholder="如:归雁客栈、王宫" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="closeComposer">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!draft.name.trim()" @click="addNpc">添加</button>
        </footer>
      </div>
    </div>

    <!-- 编辑弹窗 -->
    <div v-if="editing" class="bbs-modal-mask" @click.self="cancelEdit">
      <div class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑角色">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑角色</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名字</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="角色名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">身份(职业 / 与主角的关系)</span>
          <input v-model="editing.title" class="bbs-input" type="text" placeholder="如:归雁客栈掌柜、青梅竹马" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">性格</span>
          <input v-model="editing.personality" class="bbs-input" type="text" placeholder="如:沉默寡言、护短" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">外貌描述</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="可选"></textarea>
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.follow" type="checkbox" class="bbs-checkbox" />
          <span class="bbs-modal-label">随行同伴(跟随主角移动,永远在场)</span>
        </label>
        <label v-if="!editing.follow" class="bbs-modal-field">
          <span class="bbs-modal-label">所在地点</span>
          <input v-model="editing.location" class="bbs-input" type="text" placeholder="如:归雁客栈、王宫" />
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </div>

    <ConfirmDialog
      :open="!!removing"
      title="删除角色"
      tone="danger"
      confirm-text="删除"
      confirm-icon="trash"
      @update:open="v => { if (!v) removing = null; }"
      @confirm="confirmRemove"
      @cancel="removing = null"
    >
      删除「{{ removing?.name }}」。此操作写入最新摘要,删除楼层可回退。
    </ConfirmDialog>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.bbs-npc-groups {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-npc-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 分组头:在场/不在场是这页的信息骨架(= AI 实际收到的分档),用细标签 + 一句说明点明取舍 */
.bbs-npc-grouphead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.bbs-npc-grouptag {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 2px 9px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
.bbs-npc-grouptag.is-present {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-npc-grouphint {
  font-size: 11.5px;
  color: var(--bbs-ink-muted);
}

.bbs-npc-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* —— 角色行:首字徽记圆盘 + 信息体。圆盘是这页的标识元素(物品/场景都没有) —— */
.bbs-npc {
  display: flex;
  gap: 11px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
/* 不在场:整行压暗,与「只发名+身份」的弱化呼应 */
.bbs-npc.is-absent {
  background: transparent;
  border-style: dashed;
}
.bbs-npc.is-absent .bbs-npc-name {
  color: var(--bbs-ink-soft);
}

.bbs-npc-disc {
  flex: 0 0 auto;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--bbs-radius-pill);
  font-family: var(--bbs-font-mono);
  font-size: 15px;
  font-weight: 600;
  /* 默认(不在场):中性灰盘 */
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-muted);
}
/* 在场:青瓷染色盘 */
.bbs-npc.is-present .bbs-npc-disc {
  background: var(--bbs-accent-soft);
  color: var(--bbs-accent);
}
/* 随行:实心盘,作同伴的最高标识 */
.bbs-npc-disc.is-follow {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}

.bbs-npc-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bbs-npc-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bbs-npc-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--bbs-ink);
  word-break: break-word;
}
.bbs-npc-title {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  min-width: 0;
  flex: 1;
  word-break: break-word;
}
.bbs-npc-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
}

.bbs-npc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.bbs-npc-flag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  color: var(--bbs-ink-muted);
}
.bbs-npc-flag.is-follow {
  color: var(--bbs-accent);
}
.bbs-npc-flag.is-nowhere {
  font-style: italic;
  opacity: 0.7;
}
.bbs-npc-trait {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}
.bbs-npc-desc {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--bbs-ink-soft);
  word-break: break-word;
}

/* 行内操作按钮:复刻 items 页(scoped 不继承,重声明同款) */
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
/* 随行开关:激活态点亮强调色,把「这是同伴」表达在按钮本身 */
.bbs-npc-pin.active {
  color: var(--bbs-accent);
}
.bbs-npc-pin.active:hover {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}

.bbs-modal-textarea {
  resize: vertical;
  min-height: 60px;
  font-family: inherit;
}
.bbs-modal-check {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.bbs-modal-check input {
  flex-shrink: 0;
}
.bbs-empty {
  flex: 1;
}
</style>
