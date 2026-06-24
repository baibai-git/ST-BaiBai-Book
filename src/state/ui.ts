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
  { value: 'pastel', label: '粉彩梦幻乐园', icon: 'sparkles' },
];

interface UiState {
  open: boolean;
  /** 当前分页 id,对应 registry 里的 key */
  activePage: string;
  theme: ThemeName;
  navPosition: NavPosition;
}

const STORAGE_KEY = 'bbs.ui.v1';

function load(): Partial<UiState> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

const saved = load();

// 存的主题可能来自旧版本或被手改坏,校验后再用,否则回落日间
const savedTheme = THEMES.some(t => t.value === saved.theme) ? (saved.theme as ThemeName) : 'day';

export const ui = reactive<UiState>({
  open: false,
  activePage: saved.activePage ?? 'summary',
  theme: savedTheme,
  navPosition: saved.navPosition ?? 'auto',
});

// 持久化用户偏好(不含 open / activePage 的临时性也无妨,一并存)
watch(
  () => [ui.theme, ui.navPosition, ui.activePage],
  () => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          theme: ui.theme,
          navPosition: ui.navPosition,
          activePage: ui.activePage,
        }),
      );
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
