<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { ui } from '@/state/ui';

defineProps<{ placement: 'top' | 'bottom' }>();
</script>

<template>
  <nav class="bbs-nav" :class="`is-${placement}`">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbs-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="ui.activePage = p.id"
    >
      <Icon :name="p.id" class="bbs-nav-icon" />
      <!-- 底部导航仅图标,顶部带文字 -->
      <span v-if="placement === 'top'" class="bbs-nav-label">{{ p.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.bbs-nav {
  display: flex;
  align-items: center;
  flex: 0 0 auto;
}

/* —— 顶部:胶囊分段,横排图标+字 —— */
.bbs-nav.is-top {
  gap: 4px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--bbs-line);
}
.bbs-nav.is-top .bbs-nav-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  border: 0;
  border-radius: var(--bbs-radius-pill);
  background: transparent;
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 14px;
  white-space: nowrap;
  transition:
    background var(--bbs-dur) var(--bbs-ease),
    color var(--bbs-dur) var(--bbs-ease);
}
.bbs-nav.is-top .bbs-nav-item:hover {
  background: var(--bbs-surface-2);
  color: var(--bbs-ink);
}
.bbs-nav.is-top .bbs-nav-item.is-active {
  background: var(--bbs-accent);
  color: var(--bbs-accent-ink);
}
.bbs-nav.is-top .bbs-nav-icon {
  font-size: 17px;
}

/* —— 底部:仅图标,等分,触达区大 —— */
.bbs-nav.is-bottom {
  justify-content: space-around;
  padding: 6px 6px;
  padding-bottom: max(6px, env(safe-area-inset-bottom));
  border-top: 1px solid var(--bbs-line);
  background: var(--bbs-surface);
}
.bbs-nav.is-bottom .bbs-nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 10px 0;
  border: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
  cursor: pointer;
  transition: color var(--bbs-dur) var(--bbs-ease);
}
.bbs-nav.is-bottom .bbs-nav-icon {
  font-size: 23px;
}
.bbs-nav.is-bottom .bbs-nav-item.is-active {
  color: var(--bbs-accent);
}

.bbs-nav-item:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
  border-radius: var(--bbs-radius-sm);
}
</style>
