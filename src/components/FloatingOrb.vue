<script setup lang="ts">
import Icon from '@/components/Icon.vue';
import { openBook, ui } from '@/state/ui';
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';

/**
 * 悬浮球 —— 柏宝书伸进宿主页面的「书签坠」。
 *
 * 形态:竖向缎带 + 底部燕尾缺口(clip-path),呼应品牌的 bookmark 图标;自定义图片也被
 * 切成同一书签轮廓,任意图都收进统一形状(这是与「又一个圆 fab」拉开差距的签名手法)。
 *
 * 行为(按用户要求):自由拖动 —— 拖到屏幕中间就停在中间;拖到接近左/右边缘才吸附贴边。
 * 贴边时半隐于边缘(只露一窄条),hover/聚焦/触摸才整条滑出;停在中间则常显。
 *
 * 位置存本机 localStorage(纯视觉态、各设备屏幕尺寸不同,同步反而会跑到屏幕外)。
 * 开关与自定义图标(ui.orbImage,服务器路径)跨设备同步,由设置承载。
 */

// 尺寸随形状 + 用户基准尺寸(ui.orbSize):书签按 0.78 宽高比(竖长方),圆/方等边正方。
// 拖动/吸附计算与内联尺寸都读它。
const orbW = computed(() => (ui.orbShape === 'bookmark' ? Math.round(ui.orbSize * 0.78) : ui.orbSize));
const orbH = computed(() => ui.orbSize);
const SNAP_ZONE = 56; // 松手时距左/右边缘 ≤ 此值即吸附贴边
const CLICK_SLOP = 6; // 位移 < 此值视为点击而非拖动
const POS_KEY = 'bbs.orb.pos.v1';

type Dock = 'left' | 'right' | 'none';
interface OrbPos {
  dock: Dock;
  /** 贴边时无意义;free 时为左上角 x(px) */
  x: number;
  /** 左上角 y(px),三种状态都用 */
  y: number;
}

function loadPos(): OrbPos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<OrbPos>;
      if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
        return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
      }
    }
  } catch {
    /* ignore */
  }
  // 默认:右侧贴边、纵向居中偏下
  return { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.6) };
}

const pos = reactive<OrbPos>(loadPos());
const dragging = ref(false);
const awake = ref(false); // hover/聚焦/拖动 → 贴边态整条滑出
let activePointer: number | null = null;
let startX = 0;
let startY = 0;
let moved = 0; // 累计位移,用于点击/拖动判定

// 进入视口后把坐标夹进可视范围(换了更小的屏幕/旋转后不至于跑出去)
function clampToViewport(): void {
  const maxY = Math.max(0, window.innerHeight - orbH.value);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - orbW.value);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }
}

function savePos(): void {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

// —— 定位样式:贴边用 left/right 锚定 + translateX 控制隐/现;free 用绝对 x/y ——
const orbStyle = computed(() => {
  const base: Record<string, string> = {
    top: `${pos.y}px`,
    width: `${orbW.value}px`,
    height: `${orbH.value}px`,
    // 静止不透明度走 CSS 变量,唤起/拖动态由类覆盖回全显
    '--orb-rest-opacity': String(Math.min(100, Math.max(20, ui.orbOpacity)) / 100),
    // 图标字号随基准尺寸缩放(原 48 球 ≈ 22px),保持图标与球体比例协调
    '--orb-icon-size': `${Math.round(ui.orbSize * 0.46)}px`,
  };
  if (pos.dock === 'left') {
    base.left = '0px';
    // 静止半隐(露 ~40%);拖动/唤起时整条滑出
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(-58%)';
  } else if (pos.dock === 'right') {
    base.right = '0px';
    base.transform = dragging.value || awake.value ? 'translateX(0)' : 'translateX(58%)';
  } else {
    base.left = `${pos.x}px`;
    base.transform = 'translateX(0)';
  }
  return base;
});

const orbImage = computed(() => ui.orbImage.trim());

// —— 拖动 ——
function onDown(e: PointerEvent) {
  activePointer = e.pointerId;
  dragging.value = true;
  moved = 0;
  startX = e.clientX;
  startY = e.clientY;
  // 记录手指相对左上角的抓取点,拖动时保持
  grabDX = e.clientX - currentLeft();
  grabDY = e.clientY - pos.y;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

let grabDX = 0;
let grabDY = 0;

/** 当前左上角的实际 x(贴边态由 right/translate 折算成绝对像素,供拖动起步用) */
function currentLeft(): number {
  if (pos.dock === 'right') return window.innerWidth - orbW.value;
  if (pos.dock === 'left') return 0;
  return pos.x;
}

function onMove(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  moved = Math.max(moved, Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY));
  // 拖动中一律切 free 跟手(整条可见)
  pos.dock = 'none';
  pos.x = e.clientX - grabDX;
  pos.y = e.clientY - grabDY;
  clampToViewport();
}

function onUp(e: PointerEvent) {
  if (!dragging.value || e.pointerId !== activePointer) return;
  dragging.value = false;
  activePointer = null;

  if (moved < CLICK_SLOP) {
    // 视为点击 → 打开柏宝书(贴边态保持)
    openBook();
    return;
  }

  // 松手吸附判定:靠近左/右边缘才贴边,否则停在原地(中间)
  const left = pos.x;
  const right = window.innerWidth - (pos.x + orbW.value);
  if (left <= SNAP_ZONE) pos.dock = 'left';
  else if (right <= SNAP_ZONE) pos.dock = 'right';
  else pos.dock = 'none';
  clampToViewport();
  savePos();
}

// —— 键盘可达 ——
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openBook();
  }
}

const onResize = () => {
  clampToViewport();
  savePos();
};
onMounted(() => {
  clampToViewport();
  window.addEventListener('resize', onResize);
});
onUnmounted(() => window.removeEventListener('resize', onResize));
</script>

<template>
  <div
    class="bbs-orb"
    :class="[`shape-${ui.orbShape}`, { 'is-dragging': dragging, 'has-image': !!orbImage }]"
    :style="orbStyle"
    role="button"
    tabindex="0"
    aria-label="打开柏宝书"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerenter="awake = true"
    @pointerleave="awake = false"
    @focus="awake = true"
    @blur="awake = false"
    @keydown="onKey"
  >
    <img v-if="orbImage" :src="orbImage" class="bbs-orb-img" alt="" draggable="false" />
    <Icon v-else name="bookmark" class="bbs-orb-icon" />
  </div>
</template>

<style scoped>
.bbs-orb {
  position: fixed;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bbs-surface);
  color: var(--bbs-accent);
  cursor: grab;
  touch-action: none;
  user-select: none;
  /* drop-shadow 对 clip-path(书签)与 border-radius(圆/方)都跟随轮廓,统一用它 */
  filter: drop-shadow(0 6px 14px oklch(0 0 0 / 0.28));
  opacity: var(--orb-rest-opacity, 0.62);
  transition:
    transform var(--bbs-dur) var(--bbs-ease),
    opacity var(--bbs-dur) var(--bbs-ease);
}

/* —— 形状 —— */
/* 书签:缎带轮廓 + 底部燕尾缺口。clip-path 天然裁切自定义图。 */
.bbs-orb.shape-bookmark {
  clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 78%, 0 100%);
}
/* 圆 / 方:border-radius + overflow 裁切自定义图 */
.bbs-orb.shape-circle {
  border-radius: 999px;
  overflow: hidden;
}
.bbs-orb.shape-square {
  border-radius: 12px;
  overflow: hidden;
}

/* 唤起(hover/聚焦/拖动)或停在中间(free) → 全显 */
.bbs-orb:hover,
.bbs-orb:focus-visible,
.bbs-orb.is-dragging {
  opacity: 1;
}
.bbs-orb:focus-visible {
  outline: none;
  color: var(--bbs-accent);
}
.bbs-orb:active {
  cursor: grabbing;
}

.bbs-orb-icon {
  font-size: var(--orb-icon-size, 22px);
  pointer-events: none;
}
/* 书签:图标上移,避开底部燕尾缺口(圆/方无缺口,居中即可) */
.bbs-orb.shape-bookmark .bbs-orb-icon {
  margin-bottom: 6px;
}

.bbs-orb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .bbs-orb {
    transition: none;
  }
}
</style>
