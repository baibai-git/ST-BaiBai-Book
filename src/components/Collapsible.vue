<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { ref } from 'vue';

const props = withDefaults(
  defineProps<{
    title: string;
    /** 初始是否展开 */
    open?: boolean;
  }>(),
  { open: true },
);

const expanded = ref(props.open);

// 用 grid-template-rows 0fr<->1fr 做高度过渡,无需测量 scrollHeight,内容自适应。
</script>

<template>
  <section class="bbs-collapsible" :class="{ 'is-open': expanded }">
    <button class="bbs-collapsible-head" type="button" :aria-expanded="expanded" @click="expanded = !expanded">
      <span class="bbs-collapsible-title">{{ title }}</span>
      <Icon name="chevron" class="bbs-collapsible-chevron" />
    </button>
    <div class="bbs-collapsible-outer">
      <div class="bbs-collapsible-inner">
        <div class="bbs-collapsible-body">
          <slot />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.bbs-collapsible {
  border: 1px solid var(--bbs-line);
  border-radius: var(--bbs-radius);
  background: var(--bbs-surface);
  overflow: hidden;
}

.bbs-collapsible-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 14px 16px;
  border: 0;
  background: transparent;
  color: var(--bbs-ink);
  cursor: pointer;
  font-family: var(--bbs-font-sans);
  font-size: 15px;
  font-weight: 600;
  text-align: left;
  transition: background var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible-head:hover {
  background: var(--bbs-surface-2);
}
.bbs-collapsible-head:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: -2px;
}

.bbs-collapsible-chevron {
  font-size: 18px;
  color: var(--bbs-ink-muted);
  transition: transform var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible.is-open .bbs-collapsible-chevron {
  transform: rotate(180deg);
}

/* 高度过渡:grid 0fr -> 1fr */
.bbs-collapsible-outer {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--bbs-dur) var(--bbs-ease);
}
.bbs-collapsible.is-open .bbs-collapsible-outer {
  grid-template-rows: 1fr;
}
.bbs-collapsible-inner {
  min-height: 0;
  overflow: hidden;
}
.bbs-collapsible-body {
  padding: 4px 16px 18px;
  border-top: 1px solid var(--bbs-line);
}
</style>
