import { hydrateSettings } from '@/api/settings';
import { bindEngine, handleGenerationIntercept } from '@/memory/engine';
import { runVectorRecall, shouldRecallForType } from '@/memory/vector/recall';
import { refreshInjection } from '@/memory/inject';
import { syncTimeTagRegex } from '@/memory/timeTag';
import { bindChatLifecycle } from '@/memory/store';
import { checkForUpdate } from '@/memory/update';
import App from '@/App.vue';
import { injectMenuButton } from '@/menu';
import { syncTopBarButton } from '@/topbar';
import { syncQuickReplyButton } from '@/quickReply';
import { bindFloorPanel } from '@/floorPanel';
import { ui } from '@/state/ui';
import { versionedAssetUrl } from '@/version';
import { watch } from 'vue';
// 这两行让 Vite 把全局样式打进 dist/index.css(随后注入 shadow root)
import '@/styles/base.css';
import '@/styles/theme.css';
import { createApp } from 'vue';

const HOST_ID = 'bbs-app-host';

/**
 * 生成拦截器:ST 在每次生成前会 await 调用 manifest.generate_interceptor 指名的全局函数,
 * 签名 (chat, contextSize, abort, type),调 abort(true) 即中止本次生成。
 * 这里委托给引擎判断「积压楼层过多」并按需拦截 + 插提示楼。挂在 globalThis 上供 ST 找到。
 */
(globalThis as Record<string, unknown>).bbs_generateInterceptor = async (
  _chat: unknown,
  _contextSize: number,
  abort: (immediately: boolean) => void,
  type: string | undefined,
): Promise<void> => {
  try {
    // 先走积压拦截:返回 true = 已 abort 本次生成,无需召回(生成不会发生)。
    const intercepted = await handleGenerationIntercept(type, abort);
    // 放行且该类型需要召回 → 阻塞式向量召回(写注入槽后再放行生成)。
    // 召回内部自带向量开关/可用性判断,失败静默降级,绝不影响生成。
    if (!intercepted && shouldRecallForType(type)) {
      await runVectorRecall();
    }
  } catch (e) {
    console.error('[柏宝书] 生成拦截器异常(放行本次生成)', e);
  }
};

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
  link.href = versionedAssetUrl('./index.css', import.meta.url);
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
  // 顶栏快速打开按钮:按开关注入/移除。watch 在开关变化(含 hydrate 回灌真值)时同步。
  syncTopBarButton(ui.showTopBar);
  watch(
    () => ui.showTopBar,
    on => syncTopBarButton(on),
  );
  // 聊天框快速回复式按钮:同上范式
  syncQuickReplyButton(ui.showQuickReply);
  watch(
    () => ui.showQuickReply,
    on => syncQuickReplyButton(on),
  );
  // 记忆系统:等 ST 的 getContext 就绪后再绑定(加载顺序不确定时轮询)
  bindMemoryWhenReady();
});

function bindMemoryWhenReady(attempt = 0) {
  if (window.SillyTavern?.getContext) {
    try {
      console.log('[柏宝书] 启动链开始绑定(getContext 就绪)');
      // 设置先 hydrate:从 extension_settings 载入(或从旧 localStorage 迁移),之后才跨设备同步
      hydrateSettings();
      bindChatLifecycle();
      bindEngine();
      // 时间标签:按开关注册/移除 ST 隐藏正则(幂等;开关变化的后续同步在 bindEngine 的 watch 里)
      syncTimeTagRegex();
      // 首屏:把当前聊天已有的记忆挂上注入
      refreshInjection();
      // 楼内摘要锚点:按设置开关注入(bindFloorPanel 内 watch 开关 + 主题,immediate 首次同步)
      bindFloorPanel();
      // 后台检测更新(实时比对本地/远端 manifest 版本;失败静默,不阻断启动)
      void checkForUpdate();
      console.log('[柏宝书] 启动链绑定完成');
    } catch (e) {
      console.error('[柏宝书] 记忆系统绑定失败', e);
    }
    return;
  }
  if (attempt > 40) return; // 最多约 20s
  setTimeout(() => bindMemoryWhenReady(attempt + 1), 500);
}
