<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import NavBar from '@/components/NavBar.vue';
import { getPage } from '@/pages/registry';
import { closeBook, cycleTheme, lastOpenedAt, THEMES, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, ref } from 'vue';

// 题首主题按钮:显示「下一个」主题的图标与名,点击即切换到它
const nextTheme = computed(() => {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  return THEMES[(i + 1) % THEMES.length];
});

// 是否窄屏(移动端):用于 nav 'auto' 的方向判定 + 抽屉手势开关。
// matchMedia 变化 Vue 不会自动追踪,用 ref 桥接成响应式。
const isNarrow = window.matchMedia('(max-width: 640px)');
const narrowFlag = ref(isNarrow.matches);
const onMq = (e: MediaQueryListEvent) => (narrowFlag.value = e.matches);
onMounted(() => isNarrow.addEventListener('change', onMq));
onUnmounted(() => isNarrow.removeEventListener('change', onMq));

const navPlacement = computed<'top' | 'bottom'>(() => {
  if (ui.navPosition === 'top') return 'top';
  if (ui.navPosition === 'bottom') return 'bottom';
  return narrowFlag.value ? 'bottom' : 'top';
});

const current = computed(() => getPage(ui.activePage));

// —— 遮罩点击关闭:仅当按下与松开都在遮罩本身。
// 避免:1) 移动端打开手势的合成 click 穿透秒关;2) 窗内按下拖到窗外误关。
let pressedOnOverlay = false;

function onOverlayPointerDown(e: PointerEvent) {
  pressedOnOverlay = e.target === e.currentTarget;
}

function onOverlayClick(e: MouseEvent) {
  const justOpened = performance.now() - lastOpenedAt < 350;
  if (!justOpened && pressedOnOverlay && e.target === e.currentTarget) closeBook();
  pressedOnOverlay = false;
}

// —— 移动端:下滑关闭抽屉 ——
const dragY = ref(0); // 当前下拉位移(px)
const dragging = ref(false);
let startY = 0;
let activePointer: number | null = null;
const CLOSE_THRESHOLD = 110; // 超过此位移松手即关闭

function onHandleDown(e: PointerEvent) {
  if (!narrowFlag.value) return;
  activePointer = e.pointerId;
  startY = e.clientY;
  dragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onHandleMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  // 只跟随向下的位移
  dragY.value = Math.max(0, e.clientY - startY);
}

function onHandleUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;
  if (dragY.value > CLOSE_THRESHOLD) {
    closeBook();
  }
  dragY.value = 0;
}

// 抽屉跟手样式:拖动时禁用过渡,松手时回弹有过渡
const windowStyle = computed(() => {
  if (!narrowFlag.value || dragY.value === 0) return undefined;
  return {
    transform: `translateY(${dragY.value}px)`,
    transition: dragging.value ? 'none' : undefined,
  };
});
</script>

<template>
  <div class="bbs-root" :data-theme="ui.theme">
    <Transition name="bbs-fade">
      <div
        v-if="ui.open"
        class="bbs-overlay"
        @pointerdown="onOverlayPointerDown"
        @click="onOverlayClick"
        @keydown.esc="closeBook"
        tabindex="-1"
      >
        <Transition name="bbs-rise" appear>
          <div class="bbs-window" :style="windowStyle" role="dialog" aria-modal="true" aria-label="柏宝书">
            <!-- 移动端抓手:可下滑关闭 -->
            <div
              v-if="navPlacement !== 'top' || narrowFlag"
              class="bbs-grabber"
              @pointerdown="onHandleDown"
              @pointermove="onHandleMove"
              @pointerup="onHandleUp"
              @pointercancel="onHandleUp"
            >
              <span class="bbs-grabber-bar"></span>
            </div>

            <!-- 题首 -->
            <header class="bbs-head">
              <span class="bbs-brand-name">柏宝书</span>
              <div class="bbs-head-actions">
                <button class="bbs-icon-btn" type="button" :title="`切换主题:${nextTheme.label}`" @click="cycleTheme">
                  <Icon :name="nextTheme.icon" />
                </button>
                <button class="bbs-icon-btn" type="button" title="关闭" @click="closeBook">
                  <Icon name="close" />
                </button>
              </div>
            </header>

            <NavBar v-if="navPlacement === 'top'" placement="top" />

            <main class="bbs-body">
              <Transition name="bbs-page" mode="out-in">
                <component :is="current.component" :key="current.id" />
              </Transition>
            </main>

            <NavBar v-if="navPlacement === 'bottom'" placement="bottom" />
          </div>
        </Transition>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* —— 移动端抓手:桌面隐藏 —— */
.bbs-grabber {
  display: none;
}

.bbs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  flex: 0 0 auto;
}

.bbs-brand-name {
  font-weight: 600;
  font-size: 16px;
  letter-spacing: -0.01em;
  color: var(--bbs-ink);
}

.bbs-head-actions {
  display: flex;
  gap: 8px;
}
.bbs-icon-btn {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--bbs-radius-sm);
  background: var(--bbs-surface-2);
  color: var(--bbs-ink-soft);
  cursor: pointer;
  font-size: 15px;
  transition:
    color var(--bbs-dur) var(--bbs-ease),
    background var(--bbs-dur) var(--bbs-ease);
}
.bbs-icon-btn:hover {
  color: var(--bbs-ink);
  background: var(--bbs-line-strong);
}
.bbs-icon-btn:focus-visible {
  outline: 2px solid var(--bbs-accent);
  outline-offset: 2px;
}

/* —— 过渡:遮罩淡入 / 窗口升起 / 换页 —— */
.bbs-fade-enter-active,
.bbs-fade-leave-active {
  transition: opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-fade-enter-from,
.bbs-fade-leave-to {
  opacity: 0;
}

.bbs-rise-enter-active,
.bbs-rise-leave-active {
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}
.bbs-rise-enter-from,
.bbs-rise-leave-to {
  opacity: 0;
  transform: translateY(16px) scale(0.985);
}

.bbs-page-enter-active,
.bbs-page-leave-active {
  transition:
    opacity 0.2s var(--bbs-ease),
    transform 0.2s var(--bbs-ease);
}
.bbs-page-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.bbs-page-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

/* —— 窗口拖动时回弹过渡 —— */
.bbs-window {
  transition: transform var(--bbs-dur) var(--bbs-ease);
}

/* ============ 移动端:抓手 + 抽屉上滑入场 ============ */
@media (max-width: 640px) {
  .bbs-grabber {
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    height: 26px;
    cursor: grab;
    touch-action: none;
  }
  .bbs-grabber-bar {
    width: 40px;
    height: 4px;
    border-radius: var(--bbs-radius-pill);
    background: var(--bbs-line-strong);
  }
  .bbs-head {
    padding: 4px 16px 12px;
  }
  /* 抽屉从底部滑入 */
  .bbs-rise-enter-from,
  .bbs-rise-leave-to {
    opacity: 1;
    transform: translateY(100%) scale(1);
  }
}
</style>
