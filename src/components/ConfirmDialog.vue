<script setup lang="ts">
/**
 * 通用确认弹窗。替代浏览器原生 confirm()——原生弹窗在 Shadow DOM 外、样式不统一。
 * 受控:用 v-model:open 控制显隐;点确定 emit confirm,点取消/遮罩/关闭 emit cancel。
 *
 * Teleport 到 modalHost(.bbs-root 直接子级,在 .bbs-body 滚动容器之外):
 * 避开 iOS「可滚动祖先内 fixed 后代定位错乱」。宿主仍在 shadow root 内,
 * scoped 样式与 --bbs-* 变量照常生效——故 to 的是 shadow 内元素,而非 Teleport to="body"。
 */
import Icon from '@/components/Icon.vue';
import { modalHost } from '@/state/ui';

withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    /** 确定按钮文案 */
    confirmText?: string;
    /** 取消按钮文案 */
    cancelText?: string;
    /** 确定按钮风格:primary=主色,danger=危险(低调描边,hover 显红) */
    tone?: 'primary' | 'danger';
    /** 确定按钮前的图标名(可选,如 trash) */
    confirmIcon?: string;
    /** 忙碌中:禁用确定按钮并显示 busyText(供「更新中…」这类需保持弹窗的异步操作) */
    busy?: boolean;
    /** 忙碌时确定按钮文案 */
    busyText?: string;
    /** 叠加在其它弹窗之上(更高 z-index),如渠道弹窗里再开删除确认 */
    topLayer?: boolean;
  }>(),
  {
    confirmText: '确定',
    cancelText: '取消',
    tone: 'primary',
    confirmIcon: '',
    busy: false,
    busyText: '',
    topLayer: false,
  },
);

const emit = defineEmits<{
  (e: 'update:open', v: boolean): void;
  (e: 'confirm'): void;
  (e: 'cancel'): void;
}>();

function cancel() {
  emit('update:open', false);
  emit('cancel');
}
function confirm() {
  emit('confirm');
}
</script>

<template>
  <Teleport :to="modalHost" :disabled="!modalHost">
    <Transition name="bbs-modal">
      <div
        v-if="open"
        class="bbs-modal-mask"
        :class="{ 'bbs-modal-mask-top': topLayer }"
        @mousedown.self="cancel"
      >
        <div class="bbs-modal bbs-modal-confirm" role="dialog" aria-modal="true" :aria-label="title">
          <header class="bbs-modal-head">
            <span class="bbs-modal-title">{{ title }}</span>
          </header>
          <p class="bbs-confirm-text">
            <slot />
          </p>
          <footer class="bbs-modal-foot">
            <span class="bbs-modal-foot-spacer"></span>
            <button class="bbs-btn" type="button" @click="cancel">{{ cancelText }}</button>
            <button
              class="bbs-btn"
              :class="tone === 'danger' ? 'bbs-btn-danger' : 'bbs-btn-primary'"
              type="button"
              :disabled="busy"
              @click="confirm"
            >
              <Icon v-if="confirmIcon" :name="confirmIcon" />
              {{ busy && busyText ? busyText : confirmText }}
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 确认弹窗特有样式(基础 .bbs-modal* 在 base.css 全局)。 */
.bbs-modal-mask-top {
  z-index: 10002;
}
.bbs-modal-confirm {
  max-width: 380px;
}
.bbs-confirm-text {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--bbs-ink-soft);
}
.bbs-modal-foot-spacer {
  flex: 1 1 auto;
}
/* 危险操作按钮:描边低调,hover 才显红,避免误触 */
.bbs-btn-danger {
  color: var(--bbs-danger);
  border-color: var(--bbs-line-strong);
}
.bbs-btn-danger:hover {
  color: var(--bbs-danger);
  border-color: var(--bbs-danger);
  background: var(--bbs-danger-soft);
}
</style>
