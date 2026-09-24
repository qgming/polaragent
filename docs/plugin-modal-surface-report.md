# 插件模态窗形态 + 速记本示例插件 · 实现报告

> 范围：给插件界面加**第三种形态 `modal`**（应用内模态窗），并新增一个用它写成的内置示例插件。
> **网络搜索不动** —— 不新增、也不把它改成插件（原 `docs/web-search-plugin-plan.md` 里的 Phase 2/3 作废，只取其中的 Phase 1）。
> 状态：已落地，端到端探针 18 项全过。

---

## 0. 一句话

插件的界面声明现在有**三种形态**：`panel`（右栏面板）、`modal`（应用内模态窗）、`window`（独立窗口）。
示例插件 `dev.oint.scratchpad`（速记本）是第一个用 `modal` 的插件：一个 760×560 的对话框，左列表右编辑器，
数据存在插件自己的私有存储里，权限卡上只有 low 与 medium，**没有 net / fs / shell**。

---

## 1. 落地清单

### 1.1 形态本身（宿主能力，任何插件都能用）

| 层 | 改动 |
| --- | --- |
| 契约 | `PluginSurfaceDecl.kind` 加 `"modal"`；新权限 `ui.modal`（low）；`PluginSurfaceOpenResult` / `PluginSurfaceInfo` / `SurfaceInfo` 同步；`PluginContributionSummary` 加 `modals` 计数 |
| 权限 | `permission-risk.ts` 的 `Record<PluginPermission, …>` 逼着补了档位；`plugin-permissions.ts` 的词条与 `plugins.perm.uiModal` / `plugins.contrib.modals` 两个语言包 |
| 清单 | 校验器接受 `modal`；三形态各要各的权限（`panel→ui.panel`、`modal→ui.modal`、`window→ui.window`）；**模态窗拒绝 `alwaysOnTop` / `skipTaskbar` / `resizable`**（那是窗口专有字段，接受而不生效正是"发布了自己没实现的字段"） |
| 主进程 | `openPluginSurface` 只对 `window` 建窗，其余两种都交给渲染层；`claimSurfaceBySession` 改为**身份按分区、surfaceId 按 URL** |
| 渲染层 | `ui-store` 新增 `pluginModal`（与搜索/设置/插件管理三个模态互斥）；`PluginSurfaceModal`（Radix `Dialog` + **复用现成的** `PluginSurfacePanel`）；`plugins-store` 分流 `{kind:"modal"}`；详情页的形态标签改**表驱动**（漏项会编译失败，三元链不会） |
| 关闭通道 | 新增 `plugins:surfaceClosed`（主进程 → 渲染层）+ preload 的 `onSurfaceClosed` + `usePluginSurfaceClose` hook |
| 测试 | `surface-decls.test.ts`（纯函数判据）、清单校验 4 条、`ui-store` 5 条 |

### 1.2 示例插件 `resources/plugins/scratchpad/`

```
plugin.json          清单：一个 modal 界面 + 4 条权限，**没有 main.cjs**（零插件代码）
ui/index.html        内联样式（CSP 允许 'unsafe-inline'），外部 .js（CSP 不允许内联脚本）
ui/app.js            列表 / 编辑器 / 搜索 / 防抖落盘 / 复制 / 删除 / 关闭
```

它在演示四件事：**模态窗形态**、**插件私有 KV 存储**（含 1 MiB 上限的错误提示）、
**`writeText` 剪贴板**（只有写、没有读，且只在用户点击时发生）、**`close()` 回程**
（页面说"我关了"，宿主把对话框收掉）。快捷键 Ctrl/Cmd+N 新建、Ctrl/Cmd+S 立即落盘。

---

## 2. 探针抓出来的三个真问题

`npm run probe:plugin-modal`（新增，18 项断言）驱动的是**真实用户路径**：Ctrl+Shift+X 打开插件管理 → 切「系统」页签 → 点界面按钮 → 看 guest → 写存储 → `close()`。它抓到三处：

### 2.1 归属判定写死 `panel`（模态窗曾经整个失效）

`claimSurfaceBySession` 原本 `find(surface => surface.kind === "panel")`：
只有模态窗的插件会 `return false`，于是它的界面**不被登记**（桥全被拒）、还**被当成普通浏览器 guest 接管**。
现在按 URL 精确匹配（`surfaceByUrl`），且 URL 未就绪时用声明顺序占位、`did-navigate` 后修正。
判据抽进了 `surface-decls.ts`（纯函数、有单测）—— 留在 `surfaces.ts` 里就没法在 node 环境测。

### 2.2 面板 / 模态窗的 guest preload **从来没拿到启动参数**（既有缺陷）

窗口形态在创建时就把 `additionalArguments` 交给了 preload；而面板 / 模态窗的 guest 是渲染层建的，
主进程只能在 `will-attach-webview` 里补 preload —— 那里**没有补参数**，于是 `window.oint.info`
恒为 `{pluginId: "", surfaceId: "", kind: "panel", pluginName: "", theme: "light"}`。

它一直没被发现，是因为**它什么都不影响**：桥照常工作（身份来自 `event.sender.id`）。
唯一看得见的后果是主题回落到浅色 —— **深色主题下打开 Git 面板会得到一块亮面板**。
现在 `will-attach-webview` 会按 src 算出参数（`surfaceArgumentsForUrl`），主题由
`broadcastTheme` 与 `openPluginSurface` 两处记下（主进程不是主题真源，只记最后听到的）。

### 2.3 "查不到插件"被当成"插件没了"（我实现里的竞态）

模态窗的"不可用就收掉"最初把 `views === null`（列表还没加载）也算了进去 ——
用户点了「打开界面」之后对话框会**一闪而过**。现在区分"还不知道"（`views === null`
或 `unavailable` 非空 → 不动）与"确定了没有"（列表已加载而插件不在其中/被停用 → 收掉）。

---

## 3. 已知缺口（这次不做，留作后续）

| 缺口 | 说明 |
| --- | --- |
| **对象形式的 `title` 恒取 `zh-CN`** | `registry.ts` 里写死 `surface.title["zh-CN"]`，所以英文界面下面板标签与模态窗标题显示中文。修法要先把用户语言（`settings.language`）引到主进程并处理"换语言后列表要重取"，属另一件事。**这次顺手验证过：它是既有的，与形态无关**（Git 面板今天就这样） |
| `openAt` 声明了但没有消费者 | 清单收得下、校验器管着取值，全仓没有一处读它 —— 与"不要发布自己没实现的字段"这条纪律冲突。要么实现（`enable` 时自动开界面，模态窗要注意渲染层就绪时序），要么撤掉 |
| `fs.*` / `ui.view` / `shell.openExternal` / `session.read` 无执行点 | 既有清单，界面已如实标注「未生效」 |
| 示例插件自身的文案只有中文 | 与另外两个内置插件一致（`git-status` / `toolkit` 同样）。插件界面的文案不进宿主语言包（约束 D），要双语得等 `info.locale` 那一类机制 |
| 模态窗里的 Escape | 焦点进了 `<webview>` 后按键到不了对话框。可用的三条路是：右上角 ✕、点遮罩、插件自己的 `close()` |

---

## 4. 验证

```
npm run typecheck      ✔（两个 tsconfig）
npm run lint           ✔（biome，502 文件）
npm test               ✔ 2427 passed | 18 skipped
npm run check:i18n     ✔ 667 个词条键双语齐备
npm run check:unwired  ✔ 新增未接线 0 | 失效 allowlist 0
npm run probe:plugin-modal  ✔ 18/18
```

---

## 5. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-24 | 初版：`modal` 形态 + 速记本示例插件；修归属判定、preload 参数、模态窗收尾竞态三处；新增端到端探针 |
