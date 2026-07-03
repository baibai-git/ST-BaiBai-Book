import type { Directive } from 'vue';

/**
 * textarea 自适应高度:默认一行,内容超出时按 scrollHeight 自动长高(封顶后出现滚动条)。
 *
 * 为什么不用固定 rows:想要「短内容占一行、长内容才换行铺开」的观感。
 * 实现:把 height 先归零再取 scrollHeight,得到贴合内容的高度写回 —— 归零是必须的,
 * 否则缩短内容时 scrollHeight 不会回落(它只反映当前 box 撑开后的值)。
 *
 * 高度上限走 CSS 的 max-height(在 .bbs-modal-textarea 上),超出即滚动,故这里不管封顶。
 * v-model 改值不触发 input 事件,故 updated 钩子里也 resize 一次(覆盖程序化赋值/回填草稿)。
 */
function resize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export const vAutosize: Directive<HTMLTextAreaElement> = {
  mounted(el) {
    el.addEventListener('input', () => resize(el));
    // 挂载时初值可能已在(编辑回填);等一帧待布局稳定再量,避免 scrollHeight 读到 0
    requestAnimationFrame(() => resize(el));
  },
  updated(el) {
    requestAnimationFrame(() => resize(el));
  },
};
