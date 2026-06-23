<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { memory, saveMemory } from '@/memory/store';
import { computed, ref } from 'vue';

const newKind = ref<'plan' | 'suspense'>('plan');
const newContent = ref('');

const openPlans = computed(() => memory.plans.filter(p => p.status === 'open'));
const resolved = computed(() => memory.plans.filter(p => p.status === 'resolved'));

function add() {
  const content = newContent.value.trim();
  if (!content) return;
  const t = Date.now();
  memory.plans.push({
    id: `plan_${t}_${memory.plans.length}`,
    kind: newKind.value,
    content,
    status: 'open',
    createdAt: t,
  });
  saveMemory();
  newContent.value = '';
}

function toggle(id: string) {
  const p = memory.plans.find(x => x.id === id);
  if (!p) return;
  if (p.status === 'open') {
    p.status = 'resolved';
    p.resolvedAt = Date.now();
  } else {
    p.status = 'open';
    p.resolvedAt = undefined;
  }
  saveMemory();
}

function remove(id: string) {
  const idx = memory.plans.findIndex(x => x.id === id);
  if (idx >= 0) {
    memory.plans.splice(idx, 1);
    saveMemory();
  }
}
</script>

<template>
  <section class="bbs-page">
    <h2 class="bbs-title">计划 · 悬念</h2>

    <div class="bbs-addplan">
      <div class="bbs-kind-toggle">
        <button
          type="button"
          class="bbs-kind"
          :class="{ 'is-on': newKind === 'plan' }"
          @click="newKind = 'plan'"
        >
          计划
        </button>
        <button
          type="button"
          class="bbs-kind"
          :class="{ 'is-on': newKind === 'suspense' }"
          @click="newKind = 'suspense'"
        >
          悬念
        </button>
      </div>
      <input
        v-model="newContent"
        class="bbs-input"
        type="text"
        placeholder="手动添加…"
        @keydown.enter="add"
      />
      <button class="bbs-btn bbs-btn-primary" type="button" @click="add">添加</button>
    </div>

    <hr class="bbs-rule" />

    <div v-if="openPlans.length || resolved.length" class="bbs-plan-wrap">
      <!-- 进行中 -->
      <div v-if="openPlans.length" class="bbs-plan-group">
        <div v-for="p in openPlans" :key="p.id" class="bbs-plan">
          <button class="bbs-plan-check" type="button" title="标记为了结" @click="toggle(p.id)"></button>
          <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? '悬念' : '计划' }}</span>
          <span class="bbs-plan-content">{{ p.content }}</span>
          <button class="bbs-plan-del" type="button" title="删除" @click="remove(p.id)">
            <Icon name="close" />
          </button>
        </div>
      </div>

      <!-- 已了结 -->
      <div v-if="resolved.length" class="bbs-plan-group is-resolved">
        <p class="bbs-plan-grouptitle">已了结</p>
        <div v-for="p in resolved" :key="p.id" class="bbs-plan is-done">
          <button class="bbs-plan-check is-checked" type="button" title="重新开启" @click="toggle(p.id)">
            <Icon name="close" />
          </button>
          <span class="bbs-plan-kind" :class="p.kind">{{ p.kind === 'suspense' ? '悬念' : '计划' }}</span>
          <span class="bbs-plan-content">{{ p.content }}</span>
          <button class="bbs-plan-del" type="button" title="删除" @click="remove(p.id)">
            <Icon name="close" />
          </button>
        </div>
      </div>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="plans" /></span>
      <p>还没有计划或悬念。摘要时会自动捕捉,也可手动添加。</p>
    </div>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-addplan {
  display: flex;
  gap: 8px;
  margin-top: 14px;
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
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.bbs-plan-wrap {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.bbs-plan-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.bbs-plan-grouptitle {
  margin: 0 0 2px;
  font-size: 12px;
  color: var(--bbs-ink-muted);
}
.bbs-plan {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
}
.bbs-plan.is-done .bbs-plan-content {
  color: var(--bbs-ink-muted);
  text-decoration: line-through;
}
.bbs-plan-check {
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--bbs-line-strong);
  border-radius: 50%;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: var(--bbs-accent-ink);
  padding: 0;
}
.bbs-plan-check.is-checked {
  background: var(--bbs-accent);
  border-color: var(--bbs-accent);
}
.bbs-plan-kind {
  flex: 0 0 auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: var(--bbs-radius-pill);
}
.bbs-plan-kind.plan {
  color: var(--bbs-accent);
  background: var(--bbs-accent-soft);
}
.bbs-plan-kind.suspense {
  color: #b8860b;
  background: rgba(184, 134, 11, 0.12);
}
.bbs-plan-content {
  flex: 1;
  font-size: 14px;
  color: var(--bbs-ink);
}
.bbs-plan-del {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  font-size: 13px;
}
.bbs-plan-del:hover {
  background: var(--bbs-surface-2);
  color: #d9534f;
}
.bbs-empty {
  flex: 1;
}
</style>
