<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import ModalMask from '@/components/ModalMask.vue';
import SummaryOnlyNotice from '@/components/SummaryOnlyNotice.vue';
import { appendOpToLatestLeaf, editItem } from '@/memory/apply';
import { derivedMeta, memory } from '@/memory/store';
import { computed, ref } from 'vue';

const newName = ref('');

// 物品/计划是从叶子摘要重放出来的派生数据,手动操作写入「最新一条有效叶子」。
// 没有任何有效叶子时无处挂载,禁止手动添加。
const hasLeaf = computed(() => derivedMeta.hasLeaf);

function addItem() {
  const name = newName.value.trim();
  if (!name) return;
  if (!appendOpToLatestLeaf({ items: { add: [{ name }] } })) return;
  newName.value = '';
}

function removeItem(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  appendOpToLatestLeaf({ items: { remove: [it.name] } });
}

/* —— 编辑弹窗:改名/数量/描述。数量留空=维持(update 无法清空,清空数量请删后重建) —— */
interface ItemEditing {
  oldName: string;
  name: string;
  qty: string; // 文本承载,空=不改数量
  desc: string;
  carried: boolean; // 是否随身
  location: string; // 非随身时的存放地
}
const editing = ref<ItemEditing | null>(null);

function openEdit(id: string) {
  const it = memory.items.find(i => i.id === id);
  if (!it) return;
  editing.value = {
    oldName: it.name,
    name: it.name,
    qty: typeof it.qty === 'number' ? String(it.qty) : '',
    desc: it.desc ?? '',
    carried: it.carried !== false, // 省略/true 视作随身
    location: it.location ?? '',
  };
}
function cancelEdit() {
  editing.value = null;
}
function saveEdit() {
  const e = editing.value;
  if (!e || !e.name.trim()) return;
  // qty 用 String() 兜底:type="number" 的 v-model 会把值转成 number(Vue 对 number input 的默认行为),
  // 直接 .trim() 会因「number 无 trim」抛错 → saveEdit 中断、弹窗不关(表现为点保存没反应)。
  const qtyStr = String(e.qty).trim();
  const qty = qtyStr === '' ? undefined : Number(qtyStr);
  // 随身 → 清空存放地;非随身 → 用填写的地点
  editItem(e.oldName, {
    name: e.name,
    qty: qty !== undefined && Number.isFinite(qty) ? qty : undefined,
    desc: e.desc,
    carried: e.carried,
    location: e.carried ? '' : e.location,
  });
  editing.value = null;
}
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title bbs-title-sub">物品</h2>
    <SummaryOnlyNotice subject="物品清单与变动" />

    <div class="bbs-additem">
      <input
        v-model="newName"
        class="bbs-input"
        type="text"
        :placeholder="hasLeaf ? '手动添加物品…' : '需先有摘要才能手动添加'"
        :disabled="!hasLeaf"
        @keydown.enter="addItem"
      />
      <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!hasLeaf" @click="addItem">添加</button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="memory.items.length" class="bbs-item-list">
      <div v-for="it in memory.items" :key="it.id" class="bbs-item">
        <div class="bbs-item-head">
          <div class="bbs-item-main">
            <span class="bbs-item-name">{{ it.name }}</span>
            <span v-if="typeof it.qty === 'number'" class="bbs-item-qty">×{{ it.qty }}</span>
            <span v-if="it.carried === false && it.location" class="bbs-item-loc">
              <Icon name="scenes" /><span class="bbs-item-loc-text">{{ it.location }}</span>
            </span>
          </div>
          <span class="bbs-item-acts">
            <button class="bbs-item-act" type="button" title="编辑" @click="openEdit(it.id)">
              <Icon name="edit" />
            </button>
            <button class="bbs-item-act bbs-item-del" type="button" title="删除" @click="removeItem(it.id)">
              <Icon name="close" />
            </button>
          </span>
        </div>
        <span v-if="it.desc" class="bbs-item-desc">{{ it.desc }}</span>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="items" /></span>
      <p>暂时空空如也。摘要时得到的物品会自动登记,也可手动添加。</p>
    </div>

    <!-- 编辑弹窗:Teleport 出滚动容器,见 ModalMask -->
    <ModalMask :open="!!editing" @close="cancelEdit">
      <div v-if="editing" class="bbs-modal" role="dialog" aria-modal="true" aria-label="编辑物品">
        <header class="bbs-modal-head">
          <span class="bbs-modal-title">编辑物品</span>
          <button class="bbs-item-act" type="button" title="关闭" @click="cancelEdit"><Icon name="close" /></button>
        </header>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">名称</span>
          <input v-model="editing.name" class="bbs-input" type="text" placeholder="物品名" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">数量(留空=不计数)</span>
          <input v-model="editing.qty" class="bbs-input" type="number" min="0" placeholder="不填则不显示数量" />
        </label>
        <label class="bbs-modal-field bbs-modal-check">
          <input v-model="editing.carried" type="checkbox" />
          <span class="bbs-modal-label">随身携带(取消勾选可指定存放地)</span>
        </label>
        <label v-if="!editing.carried" class="bbs-modal-field">
          <span class="bbs-modal-label">存放地点</span>
          <input v-model="editing.location" class="bbs-input" type="text" placeholder="如:武器库、家中" />
        </label>
        <label class="bbs-modal-field">
          <span class="bbs-modal-label">描述</span>
          <textarea v-model="editing.desc" class="bbs-input bbs-modal-textarea" rows="3" placeholder="可选"></textarea>
        </label>
        <footer class="bbs-modal-foot">
          <button class="bbs-btn" type="button" @click="cancelEdit">取消</button>
          <button class="bbs-btn bbs-btn-primary" type="button" :disabled="!editing.name.trim()" @click="saveEdit">保存</button>
        </footer>
      </div>
    </ModalMask>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-additem {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.bbs-item-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-item-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bbs-item-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0; /* 允许长名字在 flex 内收缩换行,不挤压操作按钮 */
  flex: 1;
}
.bbs-item-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--bbs-ink);
  flex: 0 0 auto; /* 占自然宽度,不收缩不省略;数量紧贴其后 */
  white-space: nowrap;
}
.bbs-item-qty {
  font-size: 12px;
  color: var(--bbs-accent);
  flex-shrink: 0;
}
.bbs-item-loc {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
  min-width: 0; /* 长地名时本标签收缩并截断,不把物品名挤换行 */
  flex: 1 1 auto; /* 占据名字/数量之后的剩余宽度;过长则在自身范围内省略 */
}
.bbs-item-loc-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bbs-item-desc {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  word-break: break-word;
}
.bbs-item-acts {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
}
/* PC(支持 hover)上操作按钮默认隐藏,悬停整行才浮现,列表更干净;
   触屏无 hover,保持常驻(否则手机点不出来)。 */
@media (hover: hover) {
  .bbs-item-acts {
    opacity: 0;
    transition: opacity var(--bbs-dur) var(--bbs-ease);
  }
  .bbs-item:hover .bbs-item-acts,
  .bbs-item-acts:focus-within {
    opacity: 1;
  }
}
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
