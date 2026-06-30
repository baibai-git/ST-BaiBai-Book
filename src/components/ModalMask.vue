<script setup lang="ts">
/**
 * 弹窗遮罩外壳:统一承载各页弹窗的 .bbs-modal-mask 层 + 遮罩点击关闭。
 *
 * Teleport 到 modalHost(.bbs-root 直接子级,在 .bbs-body 滚动容器之外):
 * 修复 iOS Safari 的老问题——「可滚动祖先内的 position:fixed 后代」会相对滚动内容、
 * 而非视口定位,导致设置页滚动后弹窗整体偏上、顶出屏幕(渠道弹窗最先暴露)。
 * 宿主仍在 shadow root 内,scoped 样式与 --bbs-* 主题变量照常生效,
 * 故 to 的是 shadow 内元素,而非会逃出 shadow 的 Teleport to="body"。
 *
 * 内容经 <slot> 投入,scoped data-v 标记随之保留,各页弹窗的独立类样式不受 Teleport 影响。
 */
import { modalHost } from '@/state/ui';

defineProps<{
  /** 叠加在其它弹窗之上(更高 z-index),如渠道弹窗里再开删除确认 */
  topLayer?: boolean;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();
</script>

<template>
  <!-- modalHost 未就绪时就地渲染兜底,绝不丢弹窗 -->
  <Teleport :to="modalHost" :disabled="!modalHost">
    <div
      class="bbs-modal-mask"
      :class="{ 'bbs-modal-mask-top': topLayer }"
      @click.self="emit('close')"
    >
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
/* 叠加层:盖在普通弹窗之上(与 ConfirmDialog 的 -top 同级) */
.bbs-modal-mask-top {
  z-index: 10002;
}
</style>
