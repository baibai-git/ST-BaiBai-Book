<script setup lang="ts">
import { computed } from 'vue';

/**
 * 内联 SVG 图标 —— 不依赖字体库,天然跨 shadow DOM。
 * 统一 24×24 视框、描边风格(currentColor + stroke),
 * 通过 CSS color / font-size(1em=当前字号)继承尺寸与颜色。
 * 新增图标:往 PATHS 里加一条 name -> 内部 <path>/<circle> 标记。
 */
const props = defineProps<{ name: string; size?: number | string }>();

// 仅放路径数据,统一的 svg 外壳在模板里。stroke 风格。
const PATHS: Record<string, string> = {
  // 摘要:文档 + 文本行
  summary:
    '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h4.5"/><path d="M9 12.5h6M9 16h6M9 9h2"/>',
  // 角色:人像
  characters: '<circle cx="12" cy="8" r="3.5"/><path d="M5.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/>',
  // 场景:山 + 日
  scenes:
    '<circle cx="8" cy="8" r="2"/><path d="M3.5 19.5 9 12l4 5"/><path d="M11.5 19.5 16 13.5l4.5 6"/><path d="M3.5 19.5h17"/>',
  // 物品:立方体
  items:
    '<path d="M12 3.5 20 8v8l-8 4.5L4 16V8z"/><path d="M4 8l8 4.5L20 8"/><path d="M12 12.5V20.5"/>',
  // 设置:滑块
  settings:
    '<path d="M5 8h9M18 8h1"/><path d="M5 16h1M10 16h9"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>',
  // 书签(品牌标)
  bookmark: '<path d="M7 4.5h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.5a1 1 0 0 1 1-1z"/>',
  // 月亮
  moon: '<path d="M19 14.5A7.5 7.5 0 1 1 9.5 5a6 6 0 0 0 9.5 9.5z"/>',
  // 太阳
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.5M12 19v2.5M4.6 4.6l1.8 1.8M17.6 17.6l1.8 1.8M2.5 12H5M19 12h2.5M4.6 19.4l1.8-1.8M17.6 6.4l1.8-1.8"/>',
  // 关闭
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  // 向下箭头(折叠指示)
  chevron: '<path d="M6 9.5 12 15.5 18 9.5"/>',
  // 计划/悬念:旗标
  plans: '<path d="M6 21V4M6 4.5h11l-2.5 3.5L17 11.5H6"/>',
  // 连接/测试
  plug: '<path d="M9 3v5M15 3v5M7 8h10v3a5 5 0 0 1-10 0z M12 16v5"/>',
  // 刷新/拉取
  refresh: '<path d="M20 11a8 8 0 0 0-14-4.5L4 8M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 4.5L20 16M20 20v-4h-4"/>',
  // 删除/垃圾桶
  trash: '<path d="M5 7h14M10 7V4.5h4V7M6 7l1 13h10l1-13"/>',
  // 编辑/铅笔
  edit: '<path d="M5 19h3.5L18 9.5 14.5 6 5 15.5z"/><path d="M13 7.5 16.5 11"/>',
  // 闪耀/梦幻(粉彩主题)
  sparkles:
    '<path d="M12 4c.6 3.4 1.6 4.4 5 5-3.4.6-4.4 1.6-5 5-.6-3.4-1.6-4.4-5-5 3.4-.6 4.4-1.6 5-5z"/><path d="M18.5 14c.3 1.5.7 1.9 2.2 2.2-1.5.3-1.9.7-2.2 2.2-.3-1.5-.7-1.9-2.2-2.2 1.5-.3 1.9-.7 2.2-2.2z"/>',
};

const inner = computed(() => PATHS[props.name] ?? '');
const dim = computed(() => (props.size ? (typeof props.size === 'number' ? `${props.size}px` : props.size) : '1em'));
</script>

<template>
  <svg
    class="bbs-icon"
    :style="{ width: dim, height: dim }"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.75"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="inner"
  />
</template>

<style scoped>
.bbs-icon {
  display: inline-block;
  flex: 0 0 auto;
  vertical-align: -0.15em;
}
</style>
