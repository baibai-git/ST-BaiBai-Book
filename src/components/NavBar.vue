<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { PAGES } from '@/pages/registry';
import { closeBook, ui } from '@/state/ui';
import { updateState } from '@/memory/update';

const props = defineProps<{ placement: 'top' | 'bottom'; narrow?: boolean }>();

// 设置页有可用更新时,在「设置」导航项上亮一个红点角标(提示用户进设置页更新)。
function showUpdateDot(id: string): boolean {
  return id === 'settings' && updateState.available;
}

// 移动端:再点一下当前页的导航按钮即关闭整窗(省得去够右上角的 ×);非当前页正常切页。
// 受 ui.navTapClose 开关控制(默认开,怕误触的用户可在设置里关)。
function onNavClick(id: string) {
  if (props.narrow && ui.navTapClose && ui.activePage === id) {
    closeBook();
    return;
  }
  ui.activePage = id;
}
</script>

<template>
  <nav class="bbs-nav" :class="[`is-${placement}`, { 'is-narrow': narrow }]">
    <button
      v-for="p in PAGES"
      :key="p.id"
      class="bbs-nav-item"
      :class="{ 'is-active': ui.activePage === p.id }"
      type="button"
      :title="p.label"
      :aria-label="p.label"
      :aria-current="ui.activePage === p.id ? 'page' : undefined"
      @click="onNavClick(p.id)"
    >
      <span class="bbs-nav-icon-wrap">
        <Icon :name="p.id" class="bbs-nav-icon" />
        <!-- 有可用更新:设置项亮红点角标 -->
        <span v-if="showUpdateDot(p.id)" class="bbs-nav-dot" aria-label="有可用更新"></span>
      </span>
      <!-- 顶部带文字;但窄屏(移动端)顶部也只放图标,否则一排带字胶囊横向放不下,会把后面的项挤出屏幕 -->
      <span v-if="placement === 'top' && !narrow" class="bbs-nav-label">{{ p.label }}</span>
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

/* —— 顶部 + 窄屏(移动端):降级为仅图标,样式与底部导航完全一致(尺寸/配色/选中态),
   仅位置在顶,免得带字胶囊横向溢出把后面的项挤出屏幕 —— */
.bbs-nav.is-top.is-narrow {
  justify-content: space-around;
  gap: 0;
  padding: 6px 6px;
}
.bbs-nav.is-top.is-narrow .bbs-nav-item {
  flex: 1;
  justify-content: center;
  gap: 0;
  padding: 10px 0;
  border-radius: 0;
  background: transparent;
  color: var(--bbs-ink-muted);
}
.bbs-nav.is-top.is-narrow .bbs-nav-item:hover {
  background: transparent;
  color: var(--bbs-ink-muted);
}
.bbs-nav.is-top.is-narrow .bbs-nav-item.is-active {
  background: transparent;
  color: var(--bbs-accent);
}
.bbs-nav.is-top.is-narrow .bbs-nav-icon {
  font-size: 23px;
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

/* —— 更新红点角标:挂在图标右上角 —— */
.bbs-nav-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.bbs-nav-dot {
  position: absolute;
  top: -2px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: var(--bbs-radius-pill);
  background: var(--bbs-danger);
  box-shadow: 0 0 0 1.5px var(--bbs-surface);
  pointer-events: none;
}
</style>
