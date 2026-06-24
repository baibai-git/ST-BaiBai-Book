import { bindEngine } from '@/memory/engine';
import { refreshInjection } from '@/memory/inject';
import { bindChatLifecycle } from '@/memory/store';
import App from '@/App.vue';
import { injectMenuButton } from '@/menu';
// 这两行让 Vite 把全局样式打进 dist/index.css(随后注入 shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import { createApp } from 'vue';

const HOST_ID = 'bbs-app-host';

/**
 * 可继承的排版属性——shadow DOM 不隔离继承,这些会透过 host 从 ST 漏进来。
 * 在 host 上用内联 !important 钉死,从根上切断继承链。
 */
const INHERITED_RESET: Record<string, string> = {
  'font-family':
    "'MiSans','HarmonyOS Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',system-ui,sans-serif",
  'font-size': '14px',
  'font-weight': '400',
  'font-style': 'normal',
  'font-variant': 'normal',
  'line-height': '1.6',
  'letter-spacing': 'normal',
  'word-spacing': 'normal',
  'text-align': 'left',
  'text-transform': 'none',
  'text-indent': '0',
  'text-shadow': 'none',
  'white-space': 'normal',
  color: '#1c242c',
  direction: 'ltr',
};

function mount() {
  // host 元素留在 ST 的 light DOM,Vue 应用整体活在它的 shadow root 里。
  let host = document.getElementById(HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HOST_ID;
    document.body.appendChild(host);
  }

  // host 不参与布局(窗口内部用 fixed 定位),并切断继承
  host.style.setProperty('display', 'contents', 'important');
  for (const [prop, value] of Object.entries(INHERITED_RESET)) {
    host.style.setProperty(prop, value, 'important');
  }

  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
  shadow.textContent = '';

  // 把我们构建出的 dist/index.css 以 <link> 注入 shadow root——
  // 这样样式只在这棵 shadow 树内生效,ST 全局样式进不来,我们的也出不去。
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  // index.js 与 index.css 在 dist 同级,据当前模块 URL 推导,部署路径无关。
  link.href = new URL('./index.css', import.meta.url).href;
  shadow.appendChild(link);

  const container = document.createElement('div');
  shadow.appendChild(container);

  const app = createApp(App);
  app.mount(container);

  $(window).on('pagehide', () => app.unmount());
}

$(() => {
  mount();
  injectMenuButton();
  // 记忆系统:等 ST 的 getContext 就绪后再绑定(加载顺序不确定时轮询)
  bindMemoryWhenReady();
});

function bindMemoryWhenReady(attempt = 0) {
  if (window.SillyTavern?.getContext) {
    try {
      console.log('[柏宝书] 启动链开始绑定(getContext 就绪)');
      bindChatLifecycle();
      bindEngine();
      // 首屏:把当前聊天已有的记忆挂上注入
      refreshInjection();
      console.log('[柏宝书] 启动链绑定完成');
    } catch (e) {
      console.error('[柏宝书] 记忆系统绑定失败', e);
    }
    return;
  }
  if (attempt > 40) return; // 最多约 20s
  setTimeout(() => bindMemoryWhenReady(attempt + 1), 500);
}
