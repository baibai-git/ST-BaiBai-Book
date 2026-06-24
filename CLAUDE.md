# ST-BaiBai-Book — 项目说明（给 Claude）

SillyTavern 第三方扩展，提供记忆 / 摘要管理界面。Vue 3 + TypeScript + Vite 构建，
产物注入 SillyTavern 页面，UI 挂载在 **Shadow DOM** 内。

## 与我协作时的约定

- **不要主动截图验证改动**。截图会把图片塞进上下文，很费 token。默认用 `vue-tsc` 类型检查 +
  `build` 验证即可；只有我明确要求看效果时，才跑 `.preview/` 截图脚本。
- **单次请求最多上传 20 张图片**。验证截图时分批读取（一次 ≤ 20 张），不要一次性把
  `.preview/` 下所有截图塞进一个 Read/请求，否则会触发 `400 At most 20 images per request`。
- 回复用中文。
- 代码注释保持现有风格：简体中文、简洁、解释「为什么」而非「做什么」。

## 关键架构约束

- **Shadow DOM**：整个 UI 渲染在 shadow root 内。scoped 样式与 `--bbs-*` 主题变量都定义在
  shadow 内的 `.bbs-root` 上。
  - ⚠️ 不要用 `<Teleport to="body">`：会把内容送出 shadow root，丢失 scoped 样式和 CSS 变量，
    导致弹窗无样式 / 被遮罩盖住（PC）/ 完全不可见（移动端）。弹窗用 `position: fixed` 内联渲染即可。
- **页面组件须单一根节点**：`App.vue` 用 `<Transition mode="out-in">` 切页，多根节点会导致切页后
  整页变空。
- **响应式桥接**：`matchMedia` 变化 Vue 不自动追踪，需用 `ref` + 事件监听桥接（见 `App.vue`）。
- **数据持久化**（⚠️ 不要改回 localStorage）：
  - 设置 → ST 的 `extension_settings`（`getContext().extensionSettings['baibai_book']` +
    `saveSettingsDebounced()`），写进服务器 `settings.json`，**跨设备/局域网同步**。见 `api/settings.ts`。
    localStorage 只在每台设备本地，换设备不同步——这是已修过的 bug。
  - `settings.ts` 用 `ready` 守门：ST 就绪后 `hydrateSettings()` 先从服务器载入真实值，**之后才放行回写**，
    否则默认值会覆盖服务器已存设置。老用户旧 localStorage 值会一次性迁移过去。
  - 摘要森林 → `chatMetadata`（随聊天走）；叶子 → 各消息 `extra.bbs_leaf`（在 chat 文件里）。见 `memory/store.ts`。

## 目录

- `src/pages/` — 各页面（`summary` 摘要、`items` 条目、`settings` 设置），`registry.ts` 注册。
- `src/memory/` — 记忆/摘要数据模型与逻辑：`store.ts` 存储、`engine.ts` 引擎、`inject.ts` 注入、
  `types.ts` 类型、`prompts.ts` 提示词。
- `src/state/ui.ts` — 全局 UI 状态（主题、导航、开关）。
- `src/st/context.ts` — 对接 SillyTavern 宿主环境。
- `src/styles/` — `base.css`、`theme.css`。
- `dist/` — 构建产物（`index.js` / `index.css` / `.map`），**需提交**。
- `.preview/` — 本地验证用的截图、seed 数据与脚本（`_shot.mjs`、`_seed.html` 等）。

## 摘要森林模型（summary）

- 摘要是一棵**森林**：压缩节点 `id` → 节点，`childIds` 可指向叶子（L1）或下层压缩节点（L2+）。
- 一个压缩节点覆盖的楼层 = 递归解析全部后代叶子的 `msgIndex`（见 `inject.ts` 与
  `summary/index.vue` 的 `collectFloors`）。
- 「已被总结」= 被任何 `childIds` 收纳的 id；列表只显示森林的根。
- 层级标签：L0 `摘要`，否则 `总结L{level}`。楼层范围标签：单楼 `#5`，跨楼 `#0 - #10`。
- 列表**倒序**：楼层越靠后越在上面。

## 构建与验证

```bash
npx vue-tsc --noEmit        # 类型检查
pnpm build                  # 或 npm run build（vite build → dist/）
pnpm watch                  # 开发监听
```

验证 UI 用 `.preview/` 下的 seed + 截图脚本（Playwright 风格），分 PC / 移动端两套，
读取截图时记得 ≤ 20 张/次。
