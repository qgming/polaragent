# Oint 插件系统实现报告：两种界面形态 + 两个真实插件走查

> **这份报告解决什么**：`docs/plugin-system-plan.md` 是总体方案，本报告把它**落到两个具体插件上** ——
> **① 桌面宠物**（独立悬浮窗口，参照 DSH 的 `dsh-pet` 21,978 下载 / PI-Desktop 的 `ui.shape: "widget"`）
> **② 右侧侧边栏 Git 管理**（面板槽 + 进程，参照 PI-Desktop 的 `pi.gitlens` / DSH 的 `dsh-git-graph` 183,722 下载）
>
> 这两个例子**正好把设计空间撑满**：宠物落在最便宜的一端（零插件代码），Git 落在最贵的一端（进程 + UI + 外部命令）。中间形态只要"少做"就行。

---

## 0. 结论先行

### 0.1 一句话

> **Oint 的插件界面只需三种形态：`describe`（描述式，宿主渲染）、`panel`（面板槽，停靠 webview）、`window`（独立窗口，可透明悬浮）。**
> **两种形态共用一套桥、一套自定义协议、一套身份网关。Git 额外需要一个插件进程 + 一个 `shell.execFile` 能力。宠物一样都不需要。**

### 0.2 两个例子各需要什么

| | 桌面宠物 | Git 管理 |
| --- | --- | --- |
| **界面形态** | `window` + `shape: "widget"`（透明、无边框、置顶、不可缩放） | `panel`（停靠右侧面板槽） |
| **需要插件进程吗** | **不需要** —— 零插件代码，只订阅宿主事件 | **需要**（T1 `utilityProcess`，用来跑 `git`） |
| **需要的能力** | `ui.window` | `ui.panel` + `shell.exec`（命令白名单 `["git"]`） |
| **需要网络吗** | 不需要 | 不需要 |
| **需要文件系统吗** | 不需要 | **不需要** —— `git` 自己读写仓库，插件只读它的 stdout |
| **安全等级** | **最低**（无代码执行、无 IO） | 中（外部命令，但参数是数组、白名单命令、cwd 受限） |
| **实现工作量** | S2（约 1.5 天） | S3 + S4（约 4 天） |

### 0.3 一个重要的副产品

**宠物插件可以完全没有 `main`。** 它只是一个 HTML 页面 + 一份清单，靠宿主推的事件（`session:turn-start` / `session:turn-end` / `session:awaiting-approval`）改变表情。

> **这是本设计里最便宜的一档插件：零代码执行。** 它证明了三档能力（`plugin-system-plan.md` §4.2）的 T0 与 T2 可以组合，而不必拖上 T1。

---

## 1. 宿主现状：哪些零件已经有

> 依据 `docs/plugin-system-plan.md` §3 的逐文件证据。**这一节决定工作量** —— 大部分零件已经在了。

| 零件 | 现状 | 证据 |
| --- | --- | --- |
| **`webviewTag` 已开** | ✅ | `main/app/window.ts:271` |
| **guest 收紧逻辑已存在** | ✅ `hardenWebviews`：清 preload、关 nodeIntegration、开 contextIsolation + sandbox | `main/app/window.ts:38-56` |
| **已有可参考的 webview 宿主实现** | ✅ `BrowserPanel` —— 建元素、挂事件、登记 guest、主进程接管 | `features/right-panel/BrowserPanel.tsx:530-700` |
| **无边框窗口已有先例** | ✅ 主窗口就是 `frame: false`（自绘标题栏） | `main/app/window.ts:256` |
| **右侧面板** | ⚠️ 有，但**六项硬编码** —— 加一个视图要改 5 处 | `stores/ui-store.ts:23/34`、`right-panel/panel-meta.ts:16`、`RightSidebar.tsx` |
| **主题令牌** | ✅ 集中在 `src/index.css`，字号角色在 `assistant-ui/type.ts` | — |
| **审批门 / 路径守卫 / 命令黑名单** | ✅ 三模式审批 + `path-guard` + `blocked-patterns.json` | `pisdk/permissions.ts`、`security/` |
| **自定义协议** | ❌ **零命中**（`registerSchemesAsPrivileged` / `protocol.handle` 全仓没有） | 本轮已 grep |
| **插件专用 preload** | ❌ 不存在（`hardenWebviews` 无条件 `delete webPreferences.preload`） | `window.ts:40` |
| **窗口管理（多窗口 / 悬浮窗）** | ❌ 只有 `createMainWindow` | `window.ts:248` |
| **插件进程（utilityProcess）** | ❌ 零命中 | 上一轮已 grep |
| **面板槽注册表** | ❌ 待 P1 做 | `plugin-system-plan.md` §5 P1 |

**结论：需要新造的只有五样** —— ①自定义协议 ②插件 preload ③身份网关 ④窗口管理 ⑤插件进程。
前四样是 S1/S2，第五样是 S4。**面板槽复用 P1 的注册表。**

---

## 2. 三种界面形态的规格

### 2.1 形态 A · `describe`（描述式，宿主渲染）

`plugin-system-plan.md` §4.7 已定：插件返回 JSON 描述，宿主用白名单组件渲染（`markdown` / `table` / `keyValue` / `list` + `action`）。

**这两个例子都用不上它** —— 宠物要动画、Git 要图谱与 diff。**但它仍应是默认形态**：它是唯一零 CSP 风险、零沙箱需求的形态，覆盖简单面板。

### 2.2 形态 B · `panel`（面板槽）—— 给 Git

**规格**：

```ts
interface PanelSurface {
  id: string;                    // 插件内唯一，^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
  kind: "panel";
  title: string | { en: string; "zh-CN": string };
  icon?: IconToken;              // 封闭 token 集（照抄 PI-Desktop：插件不能自带 SVG）
  order?: number;                // 面板选择列表里的排序，默认 0
  entry: string;                 // ./ui/git.html，相对插件根
}
```

**宿主侧的改变**（P1 注册表 + 一个新 kind）：

```ts
// features/right-panel/panel-registry.ts
type PanelContent =
  | { kind: "react"; Component: React.ComponentType<PanelProps> }
  | { kind: "plugin"; pluginId: string; surfaceId: string };

panelRegistry.register({
  id: "plugin:com.example.git-lens:git",
  content: { kind: "plugin", pluginId: "com.example.git-lens", surfaceId: "git" },
  ...descriptor,
});
```

`RightSidebar` 的 body 按 `content.kind` 分发：`react` 走既有渲染，`plugin` 走新的 `<PluginSurfaceHost kind="panel" />`（内部就是 `BrowserPanel` 那套建 `<webview>` 的代码，只是 `partition` 换成 `persist:oint-plugin-<pluginKey>`、`src` 换成 `oint-plugin://<pluginKey>/ui/git.html`）。

**三条必须守住的边界**：

1. **插件面板与内置面板同列但不同源** —— 内置六项（审查/文件/文件查看器/子智能体/浏览器/终端）永远不能被插件替换，只能被插件**新增**。（`plugin-system-plan.md` §4.7 与 §7 的非目标）
2. **不允许插件声明 `order` 抢占第一位** —— 或者更简单：**内置项永远排在插件项之前**，`order` 只在插件之间排序。
3. **面板没被选中时不加载 webview** —— 与 `BrowserPanel` 的"元素必须存在才有 guest"是同一件事，但这里反过来：**不需要就不建**，省一个进程。

### 2.3 形态 C · `window`（独立窗口）—— 给宠物

**规格**：

```ts
interface WindowSurface {
  id: string;
  kind: "window";
  title?: string | { en: string; "zh-CN": string };
  entry: string;                              // ./ui/pet.html
  shape?: "panel" | "widget";                 // 默认 "panel"
  width?: number;  height?: number;           // widget 下最小 120×120
  resizable?: boolean;                        // widget 默认 false
  alwaysOnTop?: boolean;                      // widget 默认 true
  skipTaskbar?: boolean;                      // widget 默认 true
  transparent?: boolean;                       // widget 强制 true
  openAt?: "enable" | "command";              // 默认 "command"（不要一启用就弹窗）
}
```

**`BrowserWindow` 选项映射**：

| `shape` | BrowserWindow 选项 |
| --- | --- |
| `"panel"` | `frame: false`（与主窗口一致，自绘标题栏）、`resizable: true`、`transparent: false` |
| `"widget"` | `transparent: true`、`frame: false`、`resizable: false`、`alwaysOnTop: true`、`skipTaskbar: true`、`hasShadow: false`、`backgroundColor: "#00000000"` |

**widget 的四条交互约定**（照抄 PI-Desktop 已验证的形状）：

1. **没有拖拽带** —— `--oint-surface-titlebar-height: 0px`；空白处 `-webkit-app-region: drag`，控件加 `data-oint-no-drag`（对应 PI-Desktop 的 `data-pi-plugin-no-drag`）。
2. **右键出宿主菜单**：关闭 / 最小化 / 置顶开关。**菜单由宿主渲染**，插件不能自定义。
3. **窗口形状由插件自己画**（`border-radius`、阴影、发光），**页面背景必须透明**，否则会出现一个方块。
4. **位置持久化**，恢复时**夹到可见显示器内**（拔掉外接屏后桌宠不能跑到屏幕外）。

**加载路径**：`oint-plugin://<pluginKey>/ui/pet.html`，`partition: persist:oint-plugin-<pluginKey>`，**不设 `parent`**（它不属于主窗口，主窗口最小化时它应该还在）。

> ⚠️ 一处容易漏的：**插件被禁用/卸载时必须先关掉它的所有窗口**。宿主维护 `Map<pluginId, Set<BrowserWindow>>`，在 unload 路径上统一 `destroy()`。漏了就是"插件已经卸载，桌宠还在屏幕上飘"。

---

## 3. 桥：唯一的安全边界

### 3.1 为什么必须有一个 preload

`<webview>` 的 guest **没有 preload 就无法主动向宿主发消息** —— Electron 里 guest→embedder 只有 `ipcRenderer.sendToHost()` 一条路，而那需要 preload。轮询 / `executeJavaScript` 只能宿主→guest，反向不通。

**所以 `hardenWebviews` 必须开一个**、而且**只能开一个**例外。

### 3.2 `hardenWebviews` 怎么改（**分支，不是放开**）

```ts
// main/app/window.ts
win.webContents.on("will-attach-webview", (event, webPreferences, params) => {
  /*
    判据用 src（自定义协议）而不是 partition：
    src 一定在 params 里，而且它由**宿主**在渲染层建元素时写入（见 PluginSurfaceHost），
    比 partition 字符串更能表达"这是一个插件表面"。
    ⚠️ 但两者都只是路由标签 —— 真正的门是主进程的身份网关（§3.4）：
    渲染层能伪造 src，伪造不了 webContents 的归属。
  */
  const isPluginSurface = (params.src ?? "").startsWith("oint-plugin://");

  if (isPluginSurface) {
    /*
      插件界面是唯一允许带 preload 的 guest。
      ⚠️ 三个 sandbox 开关**一个都不放松** —— 沙箱化的 preload 仍然能用
      ipcRenderer 与 contextBridge（Electron 对沙箱 preload 提供了这两者的 polyfill），
      所以这里没有理由关掉它们。
    */
    webPreferences.preload = PLUGIN_SURFACE_PRELOAD; // preload-plugin.cjs，绝对路径
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    return;
  }

  // 内置浏览器 guest：**一个字都不改**
  delete webPreferences.preload;
  webPreferences.nodeIntegration = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
});
```

> **一条实现注意**：`params.src` 在首次 `did-attach-webview` 时是可信的，但**如果渲染层在元素已经 attach 之后改 `src`，不会再次触发 `will-attach-webview`**（guest 已经建好）。所以身份网关不能只信这一次判定 —— 它必须按 **webContentsId** 登记归属（§3.4），而那是在 `did-attach-webview` 里由主进程写进 `owners` 的，渲染层改不到。

### 3.3 桥暴露什么（`window.oint`）

```ts
interface OintSurfaceApi {
  readonly plugin: {
    id: string; version: string; surfaceId: string;
    locale: string;                 // 宿主当前语言，"zh-CN" | "en-US" | …
    theme: "light" | "dark";        // 宿主当前主题
    shape: "panel" | "widget";
  };

  /** 所有表面都有：请求插件自己的进程（无 main 的插件只有宿主通道可用） */
  invoke(channel: string, payload?: unknown): Promise<unknown>;

  /** 宿主事件订阅：session:turn-start / session:turn-end /
      session:awaiting-approval / session:awaiting-input / tool:start / tool:end */
  on(event: string, handler: (payload: unknown) => void): () => void;

  /** 只有 kind:"window" 的表面有 */
  window?: {
    close(): Promise<void>;
    setAlwaysOnTop(value: boolean): Promise<void>;
    setBounds(b: { x?: number; y?: number; width?: number; height?: number }): Promise<void>;
    getBounds(): Promise<{ x: number; y: number; width: number; height: number }>;
  };

  /** 只有 kind:"panel" 的表面有 */
  panel?: { setTitle(title: string): Promise<void> };
}
```

**四条纪律**：

1. **一切注册返回 disposer**，桥上的 `on` 也返回退订函数。
2. **不暴露 `fs` / `child_process` / `net`** —— 一样都不给（这两个例子都不需要）。
3. **不暴露 `settings.write`** —— 插件要配置走 `invoke("plugin:getSettings"/"plugin:setSettings")`。
4. **宿主的能力挂在 `host.*` 通道下**（见 §3.5），与插件自定义通道**在命名空间上分开**，否则一个插件可以用同名通道盖掉宿主通道。

### 3.4 身份网关：**门是"谁在说话"，不是"说什么"**

> 这是 PI-Desktop 踩过的坑（`plugin-system-plan.md` §2.1.11 坑 2）：它的面板桥在 preload 里**没有 channel 白名单**，`channel` 是自由字符串；真正的门是主进程里的**发送方身份**。**这比"固定 channel 表"更强**，因为身份不可伪造。

```ts
// main/plugins/surface-registry.ts
const owners = new Map<number, { pluginId: string; surfaceId: string }>(); // webContentsId → 归属

ipcMain.handle(IPC.plugin.surfaceInvoke, async (event, channel: string, payload: unknown) => {
  const owner = owners.get(event.sender.id);
  // 1) 身份：这个 webContents 是不是我注册过的插件表面？
  if (owner === undefined) throw pluginError("PERMISSION_DENIED", "unknown surface");
  // 2) 已授予：插件此刻还是启用状态吗？
  const loaded = registry.getLoaded(owner.pluginId);
  if (loaded === undefined) throw pluginError("PLUGIN_DISABLED", "plugin not loaded");
  // 3) 路由：宿主通道 → 宿主处理；其余 → 插件进程
  if (channel.startsWith("host.")) return hostChannels.dispatch(loaded, owner, channel, payload);
  return processBroker.call(owner.pluginId, {
    method: "panel.invoke",
    payload: { channel, payload, surfaceId: owner.surfaceId },
    timeoutMs: 30_000,
  });
});
```

**没有 channel 白名单，是因为不需要** —— 一个插件只能调到自己进程里的东西，而它自己进程里的东西本来就是它自己的。**跨插件越权在身份层就被挡住了。**

### 3.5 宿主通道（`host.*`）—— 只给无 `main` 插件用的最小集

宠物不需要插件进程，所以要有一小组**宿主直接实现**的只读通道：

| 通道 | 返回 |
| --- | --- |
| `host.app.info` | `{ version, locale, theme }` |
| `host.sessions.list` | 会话摘要（**不含消息正文**） |
| `host.session.stats` | 当前会话的 token / 成本 / 轮次（对齐已有的 `session-stats`） |

**刻意不给**：读消息正文、读写文件、执行命令、访问网络。宠物用不上，而给了就等于给每个无代码插件开了一条读取一切的通道。

---

## 4. 自定义协议 `oint-plugin://`

### 4.1 为什么必须有

不用 `file://` 的三个理由：

1. **每个插件需要一个独立的 origin**。`file://` 在 Chromium 里是 opaque origin，`localStorage` / `IndexedDB` 会被共享或禁用 —— 两个插件会撞存储。自定义协议按 **host = pluginKey** 天然分出 origin。
2. **需要一处地方做容器校验**（realpath 包含检查）与 MIME 判定。`file://` 这两件事都插不进去。
3. **需要一个能下发宿主主题的位置**（`/__oint/theme.css`），而不必往 guest 里注入脚本。

### 4.2 注册（**必须在 app ready 之前**）

```ts
// main/index.ts —— 放在 app.whenReady() 之前
protocol.registerSchemesAsPrivileged([{
  scheme: "oint-plugin",
  privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true },
}]);
```

`standard: true` 是必须的（否则不是标准 origin，`localStorage` 不可用，相对路径解析也会怪）。

### 4.3 路由与校验

```
oint-plugin://<pluginKey>/<relative-path>
```

```ts
// main/plugins/protocol.ts
async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pluginKey = url.hostname;                       // 已经是归一化过的 id
  const root = registry.getRoot(pluginKey);             // 未启用 → 404
  if (root === undefined) return new Response(null, { status: 404 });

  if (url.pathname === "/__oint/theme.css") return themeCss(pluginKey);

  // ① 先归一化，再 realpath，再判包含 —— 三步缺一不可
  const normalized = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, "");
  const target = path.resolve(root, normalized);
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(target);          // 不存在 → 404
  if (!isInside(realRoot, realTarget)) return new Response(null, { status: 403 });

  // ② MIME 白名单：只发静态资源，未知扩展名一律拒绝
  const mime = MIME[path.extname(realTarget).toLowerCase()];
  if (mime === undefined) return new Response(null, { status: 415 });

  return new Response(await fs.readFile(realTarget), {
    headers: {
      "content-type": mime,
      // ③ 插件表面的 CSP：比应用自己的更紧
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; " +
        "connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'",
    },
  });
}
```

**`connect-src 'none'` 是刻意的**：插件表面**不能自己发网络请求**。要联网就必须走 `oint.invoke` → 宿主 → 白名单域（`plugin-system-plan.md` §4.5 的出站白名单）。这同时让 `net.domains` 成为**唯一**的出口，而不是"两条路都能出去"。

**realpath 那一步不能省** —— 它与 `plugin-system-plan.md` §6 缺口七是同一件事，而且 Agent Plugins 规范 §4.1 用 `filesystem-resolved` / `MUST reject` 明确要求它。

### 4.4 主题下发

`/__oint/theme.css` 由宿主按当前主题生成（从 `index.css` 的令牌集合里取当前生效值），带 `cache-control: no-cache` 与一个 `?rev=<主题版本号>`。插件 HTML 里：

```html
<link rel="stylesheet" href="/__oint/theme.css">
```

**好处**：主题切换时宿主只要广播一次事件，表面 `location.reload()` 或重新 `link` 即可；插件作者不用自己实现深浅色。

---

## 5. T1 插件进程 —— 给 Git 的执行

### 5.1 为什么 Git 需要一个进程

`git status` / `git log` / `git diff` 要**跑外部命令**。三种做法：

| 做法 | 判断 |
| --- | --- |
| 宿主提供 `oint.shell.execFile`，插件**有**进程来调它 | ✅ **采用** |
| 宿主提供 `host.git.*` 高层通道（`host.git.status()` …） | ❌ 太窄 —— 等于把 Git 插件写进宿主，`git log --graph` 这类自定义格式马上就不够用 |
| 让面板 UI 直接调 | ❌ 渲染层零特权，不能开这个口子 |

### 5.2 进程与帧协议

照抄 PI-Desktop 已验证的形状（`plugin-system-plan.md` §4.3.1）：

```ts
utilityProcess.fork(pluginMain, [], {
  serviceName: `oint-plugin-${pluginKey}`,     // app.getAppMetrics 里可辨识
  env: pluginChildEnv(pluginId),               // 白名单 + OINT_PLUGIN_ID / OINT_PLUGIN_DATA
  stdio: "pipe",
});
```

帧协议（**不是 JSON-RPC**）：`init` / `call` / `res` / `event` / `cancel` / `log`，走 `process.parentPort`。

### 5.3 `oint.shell.execFile` —— 唯一的新能力

```ts
oint.shell.execFile(input: {
  command: string;                 // 必须是清单白名单里的裸命令名
  args: string[];                  // **数组，永不拼接成 shell 字符串**
  cwd?: string;                    // 必须落在允许根内（默认会话工作目录）
  timeoutMs?: number;              // 默认 20s，上限 110s
  maxOutputBytes?: number;         // 默认 256 KiB
}): Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>
```

**五条硬规则**：

1. **`command` 必须在清单的 `shell.exec` 白名单里**（本例只有 `["git"]`）。不在 → `PERMISSION_DENIED`。**不做 PATH 之外的解析。**
2. **`args` 逐项传递，`shell: false` 恒定** —— 这直接满足 Agent Plugins §7.2.1 的 *"a single executable token, not a shell command string"*，也是 `plugin-system-plan.md` §6 缺口六的根治形态。
3. **`cwd` 必须落在允许根内**，走 `realpath` + 包含校验（与 §4.3 同一套）。
4. **输出有上限**，超了标记 `truncated` 而不是截断后当完整结果返回。
5. **每一次调用都进审计**（`pluginId` / `command` / `argv` / `cwd` / `exitCode` / 耗时），在插件行上可查。

**为什么它是新能力而不是"插件进程本来就能 `execFile`"**：插件进程确实有完整 Node（`plugin-system-plan.md` §4.3 已如实告知）。但**走宿主通道意味着它可声明、可审计、可白名单、可统一处理 cwd 与超时**。对第三方插件，"能声明"比"能跑"重要得多。

---

## 6. 两个插件的完整走查

### 6.1 桌面宠物（T0 + T2，**零插件代码**）

**目录**：

```
desktop-pet/
├── plugin.json
└── ui/
    ├── pet.html
    ├── pet.css
    └── pet.js
```

**`plugin.json`**（Agent Plugins 核心 + `extensions.dev.oint`）：

```jsonc
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "desktop-pet",
  "version": "1.0.0",
  "description": "一只住在桌面上的像素小宠物，会在 agent 干活时忙碌、等你批准时举手。",
  "extensions": {
    "dev.oint": {
      "id": "com.example.desktop-pet",
      "apiVersion": "1",
      "permissions": ["ui.window"],
      "surfaces": [{
        "id": "pet",
        "kind": "window",
        "title": { "en": "Desktop Pet", "zh-CN": "桌面宠物" },
        "entry": "./ui/pet.html",
        "shape": "widget",
        "width": 180, "height": 180,
        "alwaysOnTop": true, "skipTaskbar": true,
        "openAt": "command"
      }]
    }
  }
}
```

**注意：没有 `main`。** 它不需要插件进程。

**`ui/pet.js`**（全部逻辑，靠宿主事件驱动）：

```js
const { plugin, on, window: win } = window.oint;
document.documentElement.dataset.shape = plugin.shape;   // "widget"

const faces = { idle: "😴", working: "🔨", waiting: "✋" };
let state = "idle";
const el = document.getElementById("pet");

on("session:turn-start", () => { state = "working"; render(); });
on("session:turn-end",   () => { state = "idle";    render(); });
on("session:awaiting-approval", () => { state = "waiting"; render(); });

function render() { el.textContent = faces[state]; }

// 右键的宿主菜单由宿主提供；这里只处理左键拖拽之外的点击反应
el.addEventListener("click", () => { el.animate([{ transform: "scale(1)" }, { transform: "scale(1.2)" }, { transform: "scale(1)" }], 240); });
```

**`ui/pet.css`** 的关键三行：

```css
html, body { background: transparent; margin: 0; overflow: hidden; }
body { -webkit-app-region: drag; }            /* 空白处拖窗口 */
#pet { -webkit-app-region: no-drag; }          /* 宠物本身可点 */
```

**宿主侧走一遍**：

1. 用户在设置 → 插件里点"打开桌宠" → `IPC.plugin.openSurface({ pluginId, surfaceId: "pet" })`
2. `surface-manager.ts` 建 `BrowserWindow`（§2.3 的 widget 映射），`loadURL("oint-plugin://com_example_desktop_pet/ui/pet.html")`
3. `did-finish-load` 后：登记 `owners.set(webContentsId, { pluginId, surfaceId })`，把主题/locale 推给桥
4. 主进程每次 `emitSafe(...)` 时，同时向**所有订阅了该事件的插件表面**转发（`emitSafe` 已经在做一对一转发，这里加一路扇出）
5. 用户关窗口 → 从 `owners` 与 `Map<pluginId, Set<BrowserWindow>>` 里摘掉，**位置写进 `ui-state.json`**
6. 插件被禁用 → `closeAllSurfaces(pluginId)` → 窗口销毁

**安全画像**：无代码执行、无文件、无网络、无命令。**一个 HTML 页面而已。** 权限只有 `ui.window` 一项。

### 6.2 Git 管理（T1 + T2）

**目录**：

```
git-lens/
├── plugin.json
├── main.js                 # 插件进程：跑 git
└── ui/
    ├── git.html            # 面板表面
    ├── git.css
    └── git.js
```

**`plugin.json`**：

```jsonc
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "git-lens",
  "version": "1.0.0",
  "description": "在右侧面板里查看 Git 状态、历史、分支与差异。只读，不向 AI 暴露任何工具。",
  "extensions": {
    "dev.oint": {
      "id": "com.example.git-lens",
      "apiVersion": "1",
      "main": "./main.js",
      "permissions": ["ui.panel", "shell.exec"],
      "shell": { "exec": ["git"] },
      "surfaces": [{
        "id": "git",
        "kind": "panel",
        "title": { "en": "Git", "zh-CN": "Git" },
        "icon": "git-branch",
        "order": 20,
        "entry": "./ui/git.html"
      }]
    }
  }
}
```

> **注意 `permissions` 里没有 `fs.read`、没有网络、没有 `agent.tool.register`。** 这正是 PI-Desktop `pi.gitlens` 的姿态（它的 `safetyNotes` 写着 *"never sends network requests, and never reads credentials"*，并且 **0.2.5 主动砍掉了 agent 工具**）。git 插件是给人用的，不该让模型去提交代码。

**`main.js`**（全部执行逻辑）：

```js
const UNSUPPORTED = (channel) => { const e = new Error(`unsupported channel: ${channel}`); e.code = "UNSUPPORTED"; throw e; };

export async function onLoad(oint) {
  // 面板 UI 的每一次 invoke 都到这里
  oint.surfaces.onPanelInvoke("git", async (channel, p) => {
    switch (channel) {
      case "repo":    return git(["rev-parse", "--show-toplevel"]);
      case "status":  return git(["status", "--porcelain=v2", "--branch", "-z"]);
      case "log":     return git(["log", "--format=%H%x1f%an%x1f%at%x1f%s", "-n", String(p?.limit ?? 200)]);
      case "branches":return git(["branch", "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)"]);
      case "diff":    return git(["diff", "--no-color", "--", String(p?.path ?? "")]);
      case "show":    return git(["show", "--no-color", "--stat", "--patch", String(p?.sha)]);
      default:        return UNSUPPORTED(channel);
    }
  });
}

async function git(args) {
  const r = await oint.shell.execFile({ command: "git", args, timeoutMs: 20_000, maxOutputBytes: 512 * 1024 });
  return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.truncated };
}
```

**`ui/git.js`**（面板表面，只做渲染）：

```js
const { plugin, invoke, panel } = window.oint;

async function refresh() {
  const st = await invoke("status");
  if (st.exitCode !== 0) { renderNotARepo(); return; }
  const [log, branches] = await Promise.all([invoke("log", { limit: 200 }), invoke("branches")]);
  renderGraph(log.stdout, branches.stdout, st.stdout);
  panel.setTitle(`Git · ${basename(await invoke("repo").then(r => r.stdout.trim()))}`);
}

refresh();
// 面板可见时才轮询；不可见就停（避免后台空转）
document.addEventListener("visibilitychange", () => document.hidden ? stopPolling() : refresh());
```

**宿主侧走一遍**：

1. 插件加载 → `settings` 里出现"Git"这一行；启用后 `panelRegistry.register({ content: { kind:"plugin", … } })`
2. 用户点右侧面板选择列表里的"Git" → `RightSidebar` 渲染 `<PluginSurfaceHost kind="panel" pluginId surfaceId />`
3. 建 `<webview partition="persist:oint-plugin-com_example_git_lens" src="oint-plugin://com_example_git_lens/ui/git.html">`
4. `will-attach-webview` 判定为插件表面 → **装插件 preload**（§3.2 的分支）
5. `did-attach-webview` → 主进程按 webContents 登记归属、`owners.set(...)`
6. UI 调 `invoke("status")` → preload → `IPC.plugin.surfaceInvoke` → **身份网关**（§3.4）→ `processBroker.call(pluginId, { method: "panel.invoke", payload: { channel:"status" } })` → 插件进程的 `onPanelInvoke` → `oint.shell.execFile({ command:"git", args:[...] })` → 宿主校验白名单 + cwd → `execFile`（`shell:false`）→ 结果原路返回
7. 面板切走 → webview 元素卸载（guest 随之销毁）；插件禁用 → `closeAllSurfaces` + 进程 kill

**安全画像**：能跑**一个白名单命令**（`git`），参数是数组、cwd 受限、输出有上限、每次都审计；**不能读文件、不能联网、不能给模型加工具**。

---

## 7. 清单扩展：在 Agent Plugins 核心上加私有层

两个例子的清单都用 §4.4 的形态：**根上只有 Agent Plugins 的字段，Oint 的全部私有能力在 `extensions["dev.oint"]` 下**。

```ts
interface OintExtension {
  id: string;                  // 反向域名，宿主内部标识
  apiVersion: "1";
  main?: string;               // 有 T1 进程才写
  permissions: OintPermission[];
  shell?: { exec: string[] };  // 命令白名单，裸命令名
  surfaces?: Array<PanelSurface | WindowSurface>;
  settings?: PluginSettingContrib[];   // 宿主生成表单
}
```

**与 `plugin-system-plan.md` §4.4 的对应**：那份文件写的是 `contributes.*` + `permissions` + `fs`/`net` 全在根上的私有方案。**按 `docs/research/agent-plugins-1.0.0.md` §8 的修订建议，全部移进 `extensions["dev.oint"]`** —— 这样只写 `skills/` 与 `mcp.json` 的插件**不改一个字节就能在 10 个客户端上跑**，而写了 `dev.oint` 的插件在别的客户端上被**忽略**（规范 §8.1 是 MUST）而不是被拒。

**九条校验规则**（在 §4.4 那十条之外，本报告新增的两条）：
- `surfaces[].entry` 必须存在且落在插件根内；`kind: "window"` 且 `shape: "widget"` 时 `transparent` 强制为真、尺寸夹到 ≥120×120。
- `shell.exec` 的每一项必须是**裸命令名**（不得含 `/`、`\`、`:`、空格），且**每一项都需要 `shell.exec` 权限**；声明了 `shell.exec` 权限却没有白名单 = 校验失败（一个用不了的权限是作者笔误，不是静默无效）。

---

## 8. 分阶段实施

> 前置：`plugin-system-plan.md` 的 **P0（七个缺口）** 与 **P1（注册表化）**。本报告的 S1 与 P1 可以并行 —— S1 不碰旧代码。

| 阶段 | 内容 | 关键文件（新增/改动） | 工期 | 验收 |
| --- | --- | --- | --- | --- |
| **S1 · 表面基础** | 自定义协议 + 插件 preload + 身份网关 + 主题下发 | 新：`main/plugins/protocol.ts`、`main/plugins/surface-registry.ts`、`preload/plugin-surface.ts`；改：`main/index.ts`（schemes）、`app/window.ts`（`hardenWebviews` 分支） | 2 天 | 手写一个最小 HTML 插件，能在窗口里打开、能 `invoke("host.app.info")` 拿到语言与主题；**浏览器 guest 的行为一字未变**（既有 `BrowserPanel` 测试仍绿） |
| **S2 · 独立窗口（宠物）** | 窗口管理 + `widget` 形状 + 位置持久化 + 随插件卸载关闭 | 新：`main/plugins/surface-manager.ts`、`renderer/plugins/PluginSurfaceWindow`（无，窗口不经过渲染层）；改：`ipc/plugins.ts` | 1.5 天 | **桌面宠物插件跑起来**：透明、无边框、置顶、可拖、右键出宿主菜单；禁用插件后窗口消失；重启后回到原位置 |
| **S3 · 面板槽（Git 的 UI）** | 面板注册表加 `content.kind: "plugin"` + 停靠 webview | 改：`right-panel/panel-registry.ts`、`RightSidebar.tsx`；新：`right-panel/PluginSurfaceHost.tsx` | 1.5 天 | Git 面板能出现、能被选中、能显示一段静态 HTML；内置六项排它之前 |
| **S4 · 插件进程（Git 的执行）** | `utilityProcess` + 帧协议 + `oint.shell.execFile` + 审计 | 新：`main/plugins/host-process.ts`、`main/plugins/broker.ts`、`main/plugins/child-env.ts`；改：`pisdk/permissions.ts`（`shell.exec` 风险档） | 2.5 天 | **Git 插件跑起来**：状态/日志/分支/差异四类调用都通；`git commit` 这类非白名单命令被拒；插件进程 `process.env` 看不到 API Key 与 `OINT_HOME` |
| **S5 · 收尾** | 设置里的插件行（权限、贡献物、错误）、卸载清理、`probe:plugins` 冒烟 | 新：`features/settings/panels/PluginsPanel.tsx`、`scripts/probe-plugins.mjs` | 2 天 | 装 → 启用 → 用 → 禁用 → 卸载全链路；冒烟用独立 `OINT_HOME` |

**合计约 9.5 天**（不含 P0/P1）。**S2 结束就能看到桌宠，S4 结束就能看到 Git 面板** —— 两个可见的里程碑。

---

## 9. 必须同步修的宿主缺口

**S1/S2 之前必须完成的**（否则新表面会继承旧洞）：

| 缺口 | 为什么这两个例子会碰到它 |
| --- | --- |
| **缺口七 · 路径守卫不做 realpath**（`plugin-system-plan.md` §6） | §4.3 的协议处理器**必须**做 realpath 包含校验；如果宿主的 `path-guard` 已经有一个"正确实现"，直接复用而不是写第二份 —— 而它现在缺这一步 |
| **缺口四 · 没有 `setPermissionRequestHandler`** | 插件表面用的是 webview guest 分区。**不装权限处理器，桌宠页面的 `getUserMedia` 会按 Electron 默认被放行**。虽然 `connect-src 'none'` 挡了网络，但设备权限是另一条路 |
| **缺口二 · `settings.write` 无写侧校验** | 插件面板的配置要走插件自己的命名空间，**不能碰 `settings`**。写侧校验是这条纪律的前提 |
| **缺口三 · `exec` 全量继承环境** | Git 插件要跑 `git`。**如果子进程继承全量环境，`git` 的 credential helper 就能拿到进程里的令牌** —— 这条对本例是直接的 |

**S1 自己做、不复用旧代码的两处**（避免"两套路径都能出去"，PI-Desktop 的坑 1）：

- **协议处理器里的容器校验是唯一一份**，不要既在协议层又在别处判。
- **身份网关是唯一的入口**，`IPC.plugin.surfaceInvoke` 之外**不允许**任何通到插件进程的通道。

---

## 10. 风险与不做的事

| 风险 / 非目标 | 说明 |
| --- | --- |
| **不允许插件替换内置面板** | 内置六项永远在，插件只能新增。`order` 只在插件之间生效，且内置项永远排前 |
| **不允许插件往主渲染进程注入代码** | 约束 A（CSP `script-src 'self'`）不动。所有插件界面都在**独立 webview / 独立窗口**里 |
| **不接受插件自带的图标文件** | 用封闭的 `IconToken` 集（照抄 PI-Desktop：图标画在宿主 chrome 里，未知 token 降级为字母块） |
| **不给无 `main` 插件开放 `host.*` 之外的通道** | 宠物用不到，给了等于开一条读一切的路 |
| **@ 不把 `shell.exec` 做成通用 `exec`** | 白名单是裸命令名 + 参数数组 + `shell: false`。**这三条一起才成立**；少任何一条就退化成 `plugin-system-plan.md` §6 缺口六 |
| **@ widget 窗口不设 `parent`** | 它属于桌面，不属于主窗口。主窗口最小化时桌宠应该还在 |
| **@ 别在 `will-attach-webview` 里放松 sandbox** | 沙箱化的 preload 仍能用 `ipcRenderer` 与 `contextBridge`，所以三个开关一个都不用动 |

---

## 11. 与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `docs/plugin-system-plan.md` | 总体方案。本报告是它 **§4.7（UI 扩展点）与 §5 P5（T2）** 的落地细化，并**采纳了 §4.4 规则 10 的 Agent Plugins 核心 + `extensions.dev.oint` 形态** |
| `docs/research/real-plugin-survey.md` | 需求依据。**桌面宠物**对应它的原型 1（改界面，DSH `ui` 类 719 个插件 / 122 万次下载，`dsh-pet` 21,978）；**Git 面板**对应原型 1 与原型 7（`dsh-git-graph` 183,722 / `pi.gitlens` 449） |
| `docs/research/agent-plugins-1.0.0.md` | 清单形态依据。§8 的"把 schema 钉在 commit 上""手写清单校验"两条本报告已默认遵守 |
| `docs/research/real-plugin-survey.md` | 桥与帧协议的样板来源：PI-Desktop 的身份网关、`panel.invoke`、`widget` 形状、`data-*-no-drag` 已内联在 `plugin-system-plan.md` §2.1.11 / §4.3.1 |
| `docs/plugin-system-plan.md` §2.1.11 / §4.3.1 / §4.9 | 帧协议、预算常量、生命周期与 `widget` 约定的**权威出处**（原 PI-Desktop 子代理报告已移除，结论已内联） |
