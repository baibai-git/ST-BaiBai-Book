/**
 * 楼内摘要面板注入(生命周期宿主)。
 *
 * 每条**真实 AI 楼**(isRealAiReply,含已标番外者)在 .mes_text 后挂一个 host,
 * host 内 attachShadow + 共享 dist/index.css → 挂一个 FloorPanel.vue 实例(props: floor, tick)。
 * 卡片外观、抽屉动画、只读/编辑全在组件里;本模块只管:注入/清理、事件驱动、防重复、样式共享。
 *
 * chat 非 reactive:用一个共享 reactive tick,相关事件触发时 +1,组件 watch 它重读当前楼数据。
 * 样式隔离:每楼独立 shadow,共享同一份构造样式表(adoptedStyleSheets,一次解析 N 次采用),
 * 避免 Horae「每楼一份 CSS 副本」的开销;构造失败回退 <link>。
 */
import { createApp, reactive, type App } from 'vue';
import FloorPanel from '@/components/FloorPanel.vue';
import { getContext } from '@/st/context';
import { isRealAiReply } from '@/memory/engine';
import { apiSettings, engineActiveHere } from '@/api/settings';
import { watch } from 'vue';
import { versionedAssetUrl } from '@/version';

const HOST_CLASS = 'bbs-fp-host';
const MARK_ATTR = 'data-bbs-fp'; // 标在 .mes 上,防重复注入

let enabled = false;
let observer: MutationObserver | null = null;
let sharedSheet: CSSStyleSheet | null = null;
let cssHref = '';
const bound = new Set<string>(); // 已绑定的事件名(幂等)

// 共享刷新信号:任何会改变楼层叶子/番外态的事件都 +1,组件据此重读 chat。
const signal = reactive({ tick: 0 });
function bumpTick(): void {
  signal.tick++;
}

interface Mounted {
  host: HTMLElement;
  app: App;
}
const mountedByFloor = new Map<number, Mounted>();

/* ============ 共享样式表 ============ */

function resolveCssHref(): string {
  if (cssHref) return cssHref;
  try {
    cssHref = versionedAssetUrl('./index.css', import.meta.url);
  } catch {
    cssHref = '';
  }
  return cssHref;
}

/** 异步构造一份共享样式表(仅一次)。失败静默,注入时回退 <link>。 */
async function ensureSharedSheet(): Promise<void> {
  if (sharedSheet || typeof CSSStyleSheet === 'undefined') return;
  const href = resolveCssHref();
  if (!href) return;
  try {
    const res = await fetch(href);
    const text = await res.text();
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    sharedSheet = sheet;
    // 已挂载的补采用(首屏可能先于样式表就绪注入)
    for (const host of document.querySelectorAll(`.${HOST_CLASS}`)) {
      const root = (host as HTMLElement).shadowRoot;
      if (root && !root.adoptedStyleSheets.includes(sheet)) {
        root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      }
    }
  } catch {
    /* 回退 <link>,见 attachStyles */
  }
}

function attachStyles(root: ShadowRoot): void {
  if (sharedSheet) {
    if (!root.adoptedStyleSheets.includes(sharedSheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sharedSheet];
    }
    return;
  }
  const href = resolveCssHref();
  if (href && !root.querySelector('link[data-bbs-fp-css]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-bbs-fp-css', '');
    root.appendChild(link);
  }
}

/* ============ 注入 / 清理 ============ */

function currentChatLen(): number {
  return getContext()?.chat?.length ?? 0;
}
function mesEl(idx: number): HTMLElement | null {
  return document.querySelector(`.mes[mesid="${idx}"]`);
}
function activeNow(): boolean {
  return enabled && engineActiveHere();
}

/** 给某楼注入 FloorPanel(幂等)。 */
function injectFloor(idx: number): void {
  const chat = getContext()?.chat ?? [];
  if (!isRealAiReply(chat[idx])) return;

  const el = mesEl(idx);
  if (!el) return;
  if (el.getAttribute(MARK_ATTR) === '1' && mountedByFloor.has(idx)) return; // 已挂

  // 移除该楼可能残留的旧 host(mesid 复用/重渲)
  el.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());

  const host = document.createElement('div');
  host.className = HOST_CLASS;
  host.setAttribute('data-bbs-fp-floor', String(idx));
  const root = host.attachShadow({ mode: 'open' });
  attachStyles(root);
  const container = document.createElement('div');
  root.appendChild(container);

  // 传 reactive signal 对象本身(引用稳定):组件读 sig.tick 即可响应式追踪。
  // createApp 的 props 是静态快照,传原始值(number)不会更新,故必须传对象。
  const app = createApp(FloorPanel, { floor: idx, sig: signal });
  app.mount(container);

  const mesText = el.querySelector('.mes_text');
  if (mesText) mesText.insertAdjacentElement('afterend', host);
  else el.appendChild(host);

  mountedByFloor.set(idx, { host, app });
  el.setAttribute(MARK_ATTR, '1');
}

function removeFloor(idx: number): void {
  const m = mountedByFloor.get(idx);
  if (m) {
    m.app.unmount();
    m.host.remove();
    mountedByFloor.delete(idx);
  }
  mesEl(idx)?.removeAttribute(MARK_ATTR);
}

/** 全量重扫:清全部再逐楼补挂。切聊天/大改动用。 */
function rebuildAll(): void {
  for (const idx of [...mountedByFloor.keys()]) removeFloor(idx);
  document.querySelectorAll(`.${HOST_CLASS}`).forEach(n => n.remove());
  document.querySelectorAll(`.mes[${MARK_ATTR}]`).forEach(n => n.removeAttribute(MARK_ATTR));
  if (!activeNow()) return;
  const len = currentChatLen();
  const chat = getContext()?.chat ?? [];
  for (let i = 0; i < len; i++) if (isRealAiReply(chat[i])) injectFloor(i);
}

/** 补挂 DOM 里已有 .mes 但尚未挂载的 AI 楼(首屏、批量加载)。 */
function scanMissing(): void {
  if (!activeNow()) return;
  const chat = getContext()?.chat ?? [];
  document.querySelectorAll('.mes[mesid]').forEach(el => {
    const idx = Number((el as HTMLElement).getAttribute('mesid'));
    if (Number.isFinite(idx) && isRealAiReply(chat[idx]) && !mountedByFloor.has(idx)) injectFloor(idx);
  });
}

/* ============ 事件 ============ */

function onRendered(idx: unknown): void {
  if (!activeNow()) return;
  const i = Number(idx);
  setTimeout(() => {
    if (Number.isFinite(i)) injectFloor(i);
    scanMissing(); // 兜底补漏
    bumpTick(); // 摘要可能刚生成,通知已挂组件重读
  }, 50);
}

function onSwiped(idx: unknown): void {
  if (!activeNow()) return;
  const i = Number(idx);
  setTimeout(() => {
    if (!Number.isFinite(i)) return;
    // 翻页:叶子可能失效/换页,组件重读即可(host 不必重建)
    if (!mountedByFloor.has(i)) injectFloor(i);
    bumpTick();
  }, 50);
}

function bindEvents(): void {
  const ctx = getContext();
  const es = ctx?.eventSource;
  const et = ctx?.eventTypes;
  if (!es || !et) return;
  const on = (name: string | undefined, fn: (...a: unknown[]) => void) => {
    if (!name || bound.has(name)) return;
    es.on(name, fn);
    bound.add(name);
  };
  on(et.CHARACTER_MESSAGE_RENDERED, onRendered);
  on(et.USER_MESSAGE_RENDERED, () => activeNow() && setTimeout(scanMissing, 50));
  on(et.MESSAGE_SWIPED, onSwiped);
  on(et.MESSAGE_DELETED, () => activeNow() && setTimeout(rebuildAll, 50));
  on(et.MESSAGE_UPDATED, () => activeNow() && setTimeout(bumpTick, 50));
  on(et.MESSAGE_EDITED, () => activeNow() && setTimeout(bumpTick, 50));
  on(et.CHAT_CHANGED, () => setTimeout(rebuildAll, 80));
  if (et.MORE_MESSAGES_LOADED) on(et.MORE_MESSAGES_LOADED, () => activeNow() && setTimeout(scanMissing, 50));
}

/** 盯聊天区:ST 重渲消息时补挂被冲掉的 host。防抖避免流式生成期高频触发。 */
let obTimer: ReturnType<typeof setTimeout> | null = null;
function startObserver(): void {
  if (observer) return;
  const chatEl = document.getElementById('chat');
  if (!chatEl) return;
  observer = new MutationObserver(() => {
    if (!activeNow() || obTimer) return;
    obTimer = setTimeout(() => {
      obTimer = null;
      if (!activeNow()) return;
      scanMissing();
      // 校正:host 已从 DOM 脱离(被 ST 重建)但仍在表里 → 卸掉,清标记待补挂
      for (const [idx, m] of mountedByFloor) {
        if (!m.host.isConnected) {
          m.app.unmount();
          mountedByFloor.delete(idx);
          mesEl(idx)?.removeAttribute(MARK_ATTR);
        }
      }
    }, 200);
  });
  observer.observe(chatEl, { childList: true, subtree: true });
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
  if (obTimer) {
    clearTimeout(obTimer);
    obTimer = null;
  }
}

/* ============ 对外 ============ */

/** 按开关同步楼内面板的有无(幂等)。 */
export function syncFloorPanel(on: boolean): void {
  enabled = on;
  if (!on) {
    stopObserver();
    rebuildAll(); // activeNow=false → 只清不建
    return;
  }
  void ensureSharedSheet();
  bindEvents();
  startObserver();
  rebuildAll();
}

/** 启动链调用一次:开关跟随(设置项 apiSettings.ui.showFloorPanel)。主题由组件内 ui.theme 响应式绑定。 */
export function bindFloorPanel(): void {
  watch(
    () => apiSettings.ui.showFloorPanel,
    v => syncFloorPanel(!!v),
    { immediate: true },
  );
}
