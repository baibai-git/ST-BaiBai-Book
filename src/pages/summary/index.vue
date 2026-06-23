<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { deleteSummary } from '@/memory/apply';
import { checkAutoSummary, engineState } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { memory } from '@/memory/store';
import { computed } from 'vue';

// 摘要按 depth 倒序展示:二次总结在前,楼层摘要按时间正序
const ordered = computed(() => {
  return [...memory.summaries].sort((a, b) => a.createdAt - b.createdAt);
});

function fmtTime(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 删除一条摘要 + 其衍生数据(物品/计划);原文楼层保持隐藏。不可撤销,故二次确认。
function onDelete(id: string) {
  if (!confirm('删除这条摘要?它产生的物品、计划等衍生数据会一并清除(原文楼层仍保持隐藏)。此操作不可撤销。')) return;
  deleteSummary(id);
  refreshInjection();
}
</script>

<template>
  <section class="bbs-page">
    <div class="bbs-page-head">
      <h2 class="bbs-title">摘要</h2>
      <button class="bbs-btn" type="button" :disabled="engineState.running" @click="checkAutoSummary">
        <Icon name="summary" />
        {{ engineState.running ? '生成中…' : '立即摘要' }}
      </button>
    </div>

    <!-- 当前状态 -->
    <div v-if="memory.state.time || memory.state.location" class="bbs-state">
      <div v-if="memory.state.time" class="bbs-state-item">
        <span class="bbs-state-key">时间</span>
        <span class="bbs-state-val">{{ memory.state.time }}</span>
      </div>
      <div v-if="memory.state.location" class="bbs-state-item">
        <span class="bbs-state-key">地点</span>
        <span class="bbs-state-val">{{ memory.state.location }}</span>
      </div>
    </div>

    <p v-if="engineState.lastError" class="bbs-error">{{ engineState.lastError }}</p>

    <hr class="bbs-rule" />

    <!-- 摘要列表 -->
    <div v-if="ordered.length" class="bbs-summary-list">
      <article v-for="s in ordered" :key="s.id" class="bbs-summary-card" :class="{ 'is-deep': s.depth > 1 }">
        <header class="bbs-summary-meta">
          <span class="bbs-summary-badge">{{ s.depth > 1 ? '总结' : '摘要' }}</span>
          <span v-if="s.timeLabel" class="bbs-summary-time">{{ s.timeLabel }}</span>
          <span class="bbs-summary-cov">{{ s.coveredIndices.length }} 楼 · {{ fmtTime(s.createdAt) }}</span>
          <button class="bbs-summary-del" type="button" title="删除摘要(连同衍生数据)" @click="onDelete(s.id)">
            <Icon name="trash" />
          </button>
        </header>
        <p class="bbs-summary-text">{{ s.text }}</p>
      </article>
    </div>

    <div v-else class="bbs-empty">
      <span class="bbs-empty-icon"><Icon name="summary" /></span>
      <p>还没有摘要。对话累积到设定楼层后会自动生成,也可点「立即摘要」。</p>
    </div>
  </section>
</template>

<style scoped>
.bbs-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.bbs-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

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
  color: #d9534f;
}

.bbs-summary-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
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
.bbs-summary-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.bbs-summary-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--bbs-accent-ink);
  background: var(--bbs-accent);
  border-radius: var(--bbs-radius-sm);
  padding: 2px 8px;
}
.bbs-summary-time {
  font-size: 12px;
  color: var(--bbs-ink-soft);
}
.bbs-summary-cov {
  font-size: 11px;
  color: var(--bbs-ink-muted);
  margin-left: auto;
}
.bbs-summary-del {
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
.bbs-summary-del:hover {
  color: #d9534f;
  background: rgba(217, 83, 79, 0.1);
}
.bbs-summary-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
  white-space: pre-wrap;
}

.bbs-empty {
  flex: 1;
}
</style>
