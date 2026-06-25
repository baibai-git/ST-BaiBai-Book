import { apiSettings, onSettingsReady } from '@/api/settings';
import { reactive, watch } from 'vue';

/** 导航位置:auto = PC 顶部、移动端底部 */
export type NavPosition = 'top' | 'bottom' | 'auto';

/**
 * 主题。新增主题只需:
 *   1) theme.css 里加一套 .bbs-root[data-theme='xxx'] 变量;
 *   2) 这里给 ThemeName 加上 'xxx',并往 THEMES 注册表加一条。
 * 设置页与题首切换按钮都从 THEMES 自动读取,无需再改别处。
 */
export type ThemeName = 'day' | 'night' | 'pastel';

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
];

interface UiState {
  open: boolean;
  /** 当前分页 id,对应 registry 里的 key */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
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
});

// settings 跨设备同步值就绪后,把主题/导航回灌进 ui(覆盖 import 阶段的默认)
onSettingsReady(() => {
  ui.theme = validTheme(apiSettings.ui.theme);
  ui.navPosition = validNav(apiSettings.ui.navPosition);
});

// ui 改变 → 写回 apiSettings.ui(由 settings 的 watch 防抖落盘、跨设备同步);activePage 仍存本机。
watch(
  () => [ui.theme, ui.navPosition],
  () => {
    apiSettings.ui.theme = ui.theme;
    apiSettings.ui.navPosition = ui.navPosition;
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
