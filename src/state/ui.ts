import { apiSettings, onSettingsReady } from '@/api/settings';
import { reactive, ref, watch } from 'vue';

/**
 * 弹窗 Teleport 宿主:由 App.vue 挂在 .bbs-root 的直接子级(在 .bbs-body 滚动容器之外)。
 * 所有 .bbs-modal-mask 弹窗都 Teleport 到这里,避开 iOS Safari 的老问题——
 * 「可滚动祖先内的 position:fixed 后代」会相对滚动内容而非视口定位,设置页滚动后弹窗顶出屏幕。
 * 仍在 shadow root 内,scoped 样式与 --bbs-* 主题变量照常生效(故不能用 Teleport to="body")。
 */
export const modalHost = ref<HTMLElement | null>(null);

/** 导航位置:auto = PC 顶部、移动端底部 */
export type NavPosition = 'top' | 'bottom' | 'auto';

/**
 * 主题。新增主题只需:
 *   1) theme.css 里加一套 .bbs-root[data-theme='xxx'] 变量;
 *   2) 这里给 ThemeName 加上 'xxx',并往 THEMES 注册表加一条。
 * 设置页与题首切换按钮都从 THEMES 自动读取,无需再改别处。
 */
export type ThemeName = 'day' | 'night' | 'pastel' | 'green';

export interface ThemeDef {
  value: ThemeName;
  label: string;
  /** Icon 组件名,见 components/Icon.vue */
  icon: string;
}

export const THEMES: ThemeDef[] = [
  { value: 'day', label: '日间', icon: 'sun' },
  { value: 'night', label: '夜间', icon: 'moon' },
  { value: 'pastel', label: '粉彩', icon: 'sparkles' },
  { value: 'green', label: '木白', icon: 'sparkles' },
];

interface UiState {
  open: boolean;
  /** 当前分页 id,对应 registry 里的 key */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
  /** 移动端:再点当前页导航按钮即关窗(默认开,怕误触可关) */
  navTapClose: boolean;
  /** 在 ST 顶栏注入快速打开按钮(默认关) */
  showTopBar: boolean;
  /** 聊天框上方快速回复式按钮(默认关) */
  showQuickReply: boolean;
  /** 屏幕边缘悬浮球(默认关) */
  showOrb: boolean;
  /** 悬浮球自定义图标(ST 服务器图片路径;空=默认书签图标) */
  orbImage: string;
  /** 悬浮球形状:bookmark / circle / square */
  orbShape: OrbShape;
  /** 悬浮球静止不透明度(百分比 20–100) */
  orbOpacity: number;
  /** 悬浮球基准尺寸(px,32–80) */
  orbSize: number;
}

/** 悬浮球形状 */
export type OrbShape = 'bookmark' | 'circle' | 'square';
export const ORB_SHAPES: { value: OrbShape; label: string }[] = [
  { value: 'bookmark', label: '书签' },
  { value: 'circle', label: '圆形' },
  { value: 'square', label: '方形' },
];
function validOrbShape(s: string): OrbShape {
  return s === 'bookmark' || s === 'circle' || s === 'square' ? s : 'bookmark';
}

// activePage(上次停在哪一页)是纯本机临时导航态,跨设备同步无意义、且翻页即回写服务器太频繁,
// 故仍存本机 localStorage;主题/导航位置是真·设置,改存进 apiSettings.ui(→ ST 跨设备同步)。
const PAGE_STORAGE_KEY = 'bbs.ui.page.v1';

function loadActivePage(): string {
  try {
    return localStorage.getItem(PAGE_STORAGE_KEY) || 'summary';
  } catch {
    return 'summary';
  }
}

// 主题合法性校验:apiSettings.ui.theme 是裸字符串,可能来自旧版本/被手改坏,落到 ui 前先校验。
function validTheme(t: string): ThemeName {
  return THEMES.some(x => x.value === t) ? (t as ThemeName) : 'day';
}
function validNav(n: string): NavPosition {
  return n === 'top' || n === 'bottom' || n === 'auto' ? n : 'auto';
}

// 先用 apiSettings 当前值建 ui(import 阶段多为默认;hydrate 完成后由 onSettingsReady 回灌真值)。
export const ui = reactive<UiState>({
  open: false,
  activePage: loadActivePage(),
  theme: validTheme(apiSettings.ui.theme),
  navPosition: validNav(apiSettings.ui.navPosition),
  navTapClose: apiSettings.ui.navTapClose,
  showTopBar: apiSettings.ui.showTopBar,
  showQuickReply: apiSettings.ui.showQuickReply,
  showOrb: apiSettings.ui.showOrb,
  orbImage: apiSettings.ui.orbImage,
  orbShape: validOrbShape(apiSettings.ui.orbShape),
  orbOpacity: apiSettings.ui.orbOpacity,
  orbSize: apiSettings.ui.orbSize,
});

// settings 跨设备同步值就绪后,把主题/导航回灌进 ui(覆盖 import 阶段的默认)
onSettingsReady(() => {
  ui.theme = validTheme(apiSettings.ui.theme);
  ui.navPosition = validNav(apiSettings.ui.navPosition);
  ui.navTapClose = apiSettings.ui.navTapClose;
  ui.showTopBar = apiSettings.ui.showTopBar;
  ui.showQuickReply = apiSettings.ui.showQuickReply;
  ui.showOrb = apiSettings.ui.showOrb;
  ui.orbImage = apiSettings.ui.orbImage;
  ui.orbShape = validOrbShape(apiSettings.ui.orbShape);
  ui.orbOpacity = apiSettings.ui.orbOpacity;
  ui.orbSize = apiSettings.ui.orbSize;
});

// ui 改变 → 写回 apiSettings.ui(由 settings 的 watch 防抖落盘、跨设备同步);activePage 仍存本机。
watch(
  () => [
    ui.theme,
    ui.navPosition,
    ui.navTapClose,
    ui.showTopBar,
    ui.showQuickReply,
    ui.showOrb,
    ui.orbImage,
    ui.orbShape,
    ui.orbOpacity,
    ui.orbSize,
  ],
  () => {
    apiSettings.ui.theme = ui.theme;
    apiSettings.ui.navPosition = ui.navPosition;
    apiSettings.ui.navTapClose = ui.navTapClose;
    apiSettings.ui.showTopBar = ui.showTopBar;
    apiSettings.ui.showQuickReply = ui.showQuickReply;
    apiSettings.ui.showOrb = ui.showOrb;
    apiSettings.ui.orbImage = ui.orbImage;
    apiSettings.ui.orbShape = ui.orbShape;
    apiSettings.ui.orbOpacity = ui.orbOpacity;
    apiSettings.ui.orbSize = ui.orbSize;
  },
);
watch(
  () => ui.activePage,
  () => {
    try {
      localStorage.setItem(PAGE_STORAGE_KEY, ui.activePage);
    } catch {
      /* localStorage 不可用时静默 */
    }
  },
);

/**
 * 窗口最近一次打开的时间戳。用于在打开瞬间忽略遮罩关闭——
 * 移动端打开手势末尾合成的 click 会穿透到刚渲染的遮罩,造成"秒关"。
 */
export let lastOpenedAt = 0;

export function openBook(page?: string) {
  if (page) ui.activePage = page;
  ui.open = true;
  lastOpenedAt = performance.now();
}

export function closeBook() {
  ui.open = false;
}

/** 题首按钮:在所有已注册主题间循环切换 */
export function cycleTheme() {
  const i = THEMES.findIndex(t => t.value === ui.theme);
  ui.theme = THEMES[(i + 1) % THEMES.length].value;
}
