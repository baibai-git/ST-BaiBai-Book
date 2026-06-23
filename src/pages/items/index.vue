<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { memory, saveMemory } from '@/memory/store';
import { ref } from 'vue';

const newName = ref('');

function addItem() {
  const name = newName.value.trim();
  if (!name) return;
  const t = Date.now();
  memory.items.push({ id: `item_${t}_${memory.items.length}`, name, createdAt: t, updatedAt: t });
  saveMemory();
  newName.value = '';
}

function removeItem(id: string) {
  const idx = memory.items.findIndex(i => i.id === id);
  if (idx >= 0) {
    memory.items.splice(idx, 1);
    saveMemory();
  }
}
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title">物品</h2>

    <div class="bbs-additem">
      <input
        v-model="newName"
        class="bbs-input"
        type="text"
        placeholder="手动添加物品…"
        @keydown.enter="addItem"
      />
      <button class="bbs-btn bbs-btn-primary" type="button" @click="addItem">添加</button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="memory.items.length" class="bbs-item-list">
      <div v-for="it in memory.items" :key="it.id" class="bbs-item">
        <div class="bbs-item-main">
          <span class="bbs-item-name">{{ it.name }}</span>
          <span v-if="typeof it.qty === 'number'" class="bbs-item-qty">×{{ it.qty }}</span>
        </div>
        <span v-if="it.desc" class="bbs-item-desc">{{ it.desc }}</span>
        <button class="bbs-item-del" type="button" title="删除" @click="removeItem(it.id)">
          <Icon name="close" />
        </button>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="items" /></span>
      <p>暂时空空如也。摘要时得到的物品会自动登记,也可手动添加。</p>
    </div>
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
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-item-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.bbs-item-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--bbs-ink);
}
.bbs-item-qty {
  font-size: 12px;
  color: var(--bbs-accent);
}
.bbs-item-desc {
  font-size: 12px;
  color: var(--bbs-ink-muted);
  flex: 1;
}
.bbs-item-del {
  margin-left: auto;
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
.bbs-item-del:hover {
  background: var(--bbs-surface-2);
  color: #d9534f;
}
.bbs-empty {
  flex: 1;
}
</style>
