// 插件界面（独立窗口）的创建、归属登记与关闭。
//
// ## 这个文件负责把"一个 webContents"变成"一个有身份的插件界面"
//
// 顺序不能反：**先登记归属，再加载 URL**。反过来的话，页面在 `did-finish-load`
// 之前发出的调用会查不到归属而被拒 —— 而症状是"偶尔第一次打开时点了没反应"，
// 只在页面加载特别快（本地文件）时复现。
//
// ## 与内置浏览器的差别
//
// 内置浏览器（browser/service.ts）的 guest **刻意没有 preload**、也没有身份 ——
// 它是一个通用浏览器，用户让它去哪它去哪。插件界面正相反：它有 preload、有身份、
// 而且**只能待在 `oint-plugin://` 里**（导航到别的 URL 一律拦掉）。
// 两者长得像（都是 webview / BrowserWindow），但信任模型完全相反，所以不共用代码。

import path from "node:path";
import { BrowserWindow, type Session, session, type WebContents, webContents } from "electron";
import { IPC } from "@/shared/contracts/ipc";
import type {
  PluginSurfaceClosedEvent,
  PluginSurfaceDecl,
  PluginSurfaceOpenResult,
} from "@/shared/contracts/plugin";
import { installPluginProtocolOn } from "./protocol";
import { getPluginRegistry } from "./registry";
import { rendererSurfaces, surfaceByUrl } from "./surface-decls";
import { getSurfaceOwners, type SurfaceOwner } from "./surface-owners";
import { parseSurfaceUrl, pluginPartition, surfaceUrl } from "./surface-url";

/** widget 形态的默认尺寸：桌面宠物那类小挂件 */
const WIDGET_DEFAULT = { width: 240, height: 240 };
const WINDOW_DEFAULT = { width: 720, height: 560 };

/** 插件界面 preload 的路径（构建产物与 main.js 同级，见 vite.renderer.config.ts） */
export function pluginSurfacePreload(): string {
  return path.join(import.meta.dirname, "plugin-surface.cjs");
}

/**
 * 给 preload 传界面身份。
 *
 * 用 `additionalArguments` 而不是查询串：`parseSurfaceUrl` 刻意拒绝带查询串的 URL
 *（那一条是为了让"资源 URL"只有一种形状），而这是 Electron 给 preload 传参的正规通道，
 * 且**页面读不到它**（它在 preload 进程的参数里，不在 `window.location` 上）。
 */
export function surfaceArguments(owner: SurfaceOwner, pluginName: string, theme: string): string[] {
  return [
    `--oint-surface=${JSON.stringify({
      pluginId: owner.pluginId,
      surfaceId: owner.surfaceId,
      kind: owner.kind,
      pluginName,
      theme,
    })}`,
  ];
}

/**
 * 最近一次已知的主题。
 *
 * **主进程不是主题的真源**（真源在渲染层的设置里，见 ipc/plugins.ts 的 broadcastTheme），
 * 它只是记下最后听到的那一个，好让**后开的**界面在 preload 参数里带上正确的初始值。
 * 记错的最坏后果是"新开的界面先按旧主题画一帧、随后被 theme 事件纠正"。
 */
let currentTheme: "light" | "dark" = "light";

/** 记下当前主题（开界面与广播主题两条路都要调 —— 漏一条会让新界面用旧主题起手） */
export function rememberSurfaceTheme(theme: "light" | "dark"): void {
  currentTheme = theme;
}

/**
 * 给一个 `<webview>` 的 src 算 preload 的启动参数 —— **宿主在渲染层的那两类界面**
 *（面板 / 模态窗）走这条路。
 *
 * ## 为什么必须有它（这是一处真实存在过的缺口）
 *
 * 窗口形态在创建时就把 `additionalArguments` 交给了 preload；而面板 / 模态窗的 guest
 * 是渲染层建的，主进程只能在 `will-attach-webview` 里补 preload —— 那里如果**没有**
 * 一并补参数，preload 里的 `readInfo()` 就找不到 `--oint-surface=`，于是
 * `window.oint.info` 恒为空串。
 *
 * 这个缺口一直没被发现，是因为**它什么都不影响**：桥照常工作（身份来自
 * `event.sender.id`，与参数无关），只有"自我介绍"是空的 —— 唯一看得见的后果是
 * 主题回落到 `light`，深色用户会看到一块亮面板。`probe:plugin-modal` 抓到了它。
 *
 * 输入只有 src：`parseSurfaceUrl` 解出插件，`surfaceByUrl` 解出界面声明。
 * 解不出来（不是插件界面 / 插件已停用 / URL 不是声明里的 entry）就返回 undefined，
 * 调用方按普通 webview 处理。
 */
export function surfaceArgumentsForUrl(src: string): string[] | undefined {
  const parsed = parseSurfaceUrl(src);
  if (parsed === null) return undefined;

  const registry = getPluginRegistry();
  const source = registry.enabledSources().find((candidate) => candidate.id === parsed.pluginId);
  if (source === undefined) return undefined;

  /*
    界面声明按 URL 精确匹配；匹配不到就退回"渲染层宿主的第一个" ——
    与归属登记（claimSurfaceBySession）同一条规则，两处必须一致，
    否则会出现"归属记的是 A、参数里写的是 B"这种只有日志能看出来的错位。
  */
  const declared = rendererSurfaces(source.manifest.surfaces);
  const surface = surfaceByUrl(source.id, declared, src) ?? declared[0];
  if (surface === undefined) return undefined;

  const pluginName = registry.find(source.id)?.name ?? source.id;
  return surfaceArguments(
    { pluginId: source.id, surfaceId: surface.id, kind: surface.kind },
    pluginName,
    currentTheme,
  );
}

/**
 * 给插件分区的 guest 装**全拒绝**的权限门。
 *
 * 与内置浏览器那个分区相反：那边放行 `fullscreen` 与 `clipboard-sanitized-write`
 *（页面拿不到用户数据，只是渲染行为不同），而插件界面**一个都不需要** ——
 * 它不播视频、也没有"复制"按钮要写剪贴板（那走桥的 `writeText`，且要 `clipboard.write` 权限）。
 *
 * 不装处理器的后果见 window.ts 里那段说明：**Electron 的默认行为不是拒绝**。
 * 一个插件页面调 `getUserMedia` 时，没有任何一处代码说过"不"。
 *
 * 幂等：同一个分区被处理多次（多个面板、反复开关）时重复设同一个处理器是安全的。
 */
/**
 * 把一批插件的分区**提前**准备好（协议处理器 + 权限门）。
 *
 * ## 为什么不能等到创建界面时才装
 *
 * `<webview>` 一被插进 DOM 就开始加载 `src`。而"这个 webview 属于哪个插件"要到
 * `did-attach-webview` 才知道 —— 那时导航**已经在飞了**，再装协议处理器已经晚了。
 * 晚了的后果不是"加载失败"，而是 Chromium 把 `oint-plugin://` 当成外部协议
 * 交给操作系统（Windows 上弹「获取打开此链接的应用」）。
 *
 * 所以准备动作挂在**插件加载**上（`refreshPluginContributions` 之后），
 * 而不是挂在界面创建上：用户能点到那个面板时，分区一定已经就绪。
 */
export function preparePluginPartitions(pluginIds: readonly string[]): void {
  for (const id of pluginIds) hardenPluginPartition(session.fromPartition(pluginPartition(id)));
}

export function hardenPluginPartition(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  /*
    **协议处理器也要装在这个 session 上。**

    `protocol.handle` 只作用于默认 session，而插件界面用的是各自的分区 ——
    不在这里补一次，那个分区的 webview 里 `oint-plugin://` 就没有处理器，
    Chromium 会按"外部协议"交给操作系统（Windows 上弹"获取打开此链接的应用"）。

    放在这个函数里而不是各个调用点：这个函数**本来就是"把一个分区按插件界面的
    规矩准备好"的唯一入口**，协议与权限是同一件事的两半。
  */
  installPluginProtocolOn(target);
}

/** 打开的结果（形状定义在共享契约里 —— 两边都要用同一份） */
export type OpenSurfaceResult = PluginSurfaceOpenResult;

/** 已经打开的窗口：`pluginId/surfaceId` → 窗口。同一界面**只开一个**（再点就聚焦） */
const windows = new Map<string, BrowserWindow>();

function keyOf(pluginId: string, surfaceId: string): string {
  return `${pluginId}/${surfaceId}`;
}

/** 找一个已启用的插件与它的界面声明；找不到返回 undefined（调用方给可读错误） */
async function resolveSurface(
  pluginId: string,
  surfaceId: string,
): Promise<{ decl: PluginSurfaceDecl; pluginName: string } | undefined> {
  const registry = getPluginRegistry();
  if (!registry.loaded) await registry.reload();
  const view = registry.find(pluginId);
  // **停用的插件打不开界面** —— 这一条要在建窗口之前，而不是在里面
  if (view === undefined || !view.enabled) return undefined;
  const source = registry.enabledSources().find((candidate) => candidate.id === pluginId);
  if (source === undefined) return undefined;
  const decl = source.manifest.surfaces.find((surface) => surface.id === surfaceId);
  if (decl === undefined) return undefined;
  return { decl, pluginName: view.name };
}

/**
 * 打开一个插件界面。
 *
 * **只有 `window` 在这里建东西**（主进程建 `BrowserWindow`）。面板与模态窗都不 ——
 * 两者的宿主都是渲染层的 React 组件（右栏的面板槽、应用内的对话框），
 * 所以这里只回答"该开在哪里"，由调用方分流。把渲染层的事塞进主进程会需要一个
 * "往渲染层里插一个 React 组件"的机制，而那正是面板注册表与模态窗状态在做的事。
 */
export async function openPluginSurface(
  pluginId: string,
  surfaceId: string,
  theme: "light" | "dark" = "light",
): Promise<OpenSurfaceResult> {
  const resolved = await resolveSurface(pluginId, surfaceId);
  if (resolved === undefined) {
    throw new Error(`插件 ${pluginId} 没有可用的界面 "${surfaceId}"（或插件已停用）`);
  }
  // 开界面的那一刻渲染层知道主题（它给的），记下来供后开的 webview 用
  if (theme === "light" || theme === "dark") rememberSurfaceTheme(theme);

  const { decl, pluginName } = resolved;
  // 非窗口形态：宿主在渲染层，主进程只回答"开在哪里"
  if (decl.kind !== "window") return { kind: decl.kind };

  const key = keyOf(pluginId, surfaceId);
  const existing = windows.get(key);
  if (existing !== undefined && !existing.isDestroyed()) {
    /*
      已经开着就**聚焦**，不再开一个。
      与内置浏览器的"每次点都是新标签"相反，理由不同：浏览器多开是特性（同时看两个页面），
      而一个插件的"设置窗口"开两个只会让用户困惑于改哪个。
    */
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return { kind: "window" };
  }

  const owner: SurfaceOwner = { pluginId, surfaceId, kind: "window" };
  // 窗口类与渲染层宿主**共用同一个分区**（同名），所以权限门只需装一次；
  // 面板 / 模态窗那条路在 claimRendererSurface 里也会调它（幂等）
  hardenPluginPartition(session.fromPartition(pluginPartition(pluginId)));
  const widget = decl.shape === "widget";
  const fallback = widget ? WIDGET_DEFAULT : WINDOW_DEFAULT;

  const win = new BrowserWindow({
    width: decl.width ?? fallback.width,
    height: decl.height ?? fallback.height,
    minWidth: 120,
    minHeight: 80,
    // widget = 透明无边框 + 置顶 + 不进任务栏（桌面宠物那一类）
    frame: !widget,
    transparent: widget,
    alwaysOnTop: decl.alwaysOnTop ?? widget,
    skipTaskbar: decl.skipTaskbar ?? widget,
    resizable: decl.resizable ?? !widget,
    // 透明窗口必须显式给全透明底色，否则会先闪一块白
    ...(widget ? { backgroundColor: "#00000000" } : {}),
    show: false,
    webPreferences: {
      preload: pluginSurfacePreload(),
      /*
        与主窗口同一套硬约束。**sandbox 保持 true** —— 沙箱化的 preload 仍然能拿到
        `ipcRenderer` 与 `contextBridge`，所以"给插件界面装 preload"并不需要放弃沙箱。
        这一点很容易被想反，从而以为要在"没有 preload"与"关沙箱"之间二选一。
      */
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      additionalArguments: surfaceArguments(owner, pluginName, theme),
    },
  });

  /*
    **先登记，再加载。** 反过来的话，页面在 did-finish-load 之前发出的调用会查不到
    归属而被拒 —— 症状是"偶尔第一次打开时点了没反应"，只在本地文件加载很快时复现。
  */
  getSurfaceOwners().claim(win.webContents.id, owner);
  windows.set(key, win);

  const release = (): void => {
    getSurfaceOwners().release(win.webContents.id);
    windows.delete(key);
  };
  win.on("closed", release);
  // webContents 可能先于窗口销毁（渲染进程崩溃），两条路都要清
  win.webContents.on("destroyed", release);

  // 只允许待在插件自己的资源里：外链一律交给系统浏览器（与主窗口同款处理）
  win.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("oint-plugin://")) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

  win.once("ready-to-show", () => win.show());
  await win.loadURL(surfaceUrl(pluginId, decl.entry));
  return { kind: "window" };
}

/** 关闭一个界面（`window` 关窗；`panel` 由渲染层摘标签，见下） */
/**
 * 把一条宿主事件推给**全部**插件界面。
 *
 * ## 方向：这是唯一一条反着走的
 *
 * 别的都是"插件界面 → 宿主"（invoke）。`<webview>` 里的页面**不能主动**给宿主发消息，
 * 所以"宿主发生了什么事"（主题变了）只能由宿主推过去。
 *
 * ## 为什么按权限筛
 *
 * 主题事件只发给**声明了 `ui.theme` 的插件**。不筛的话 `ui.theme` 会变成一张
 * 没人执行的纸 —— 与 `net.domains` 那条同一条纪律：清单里写的权限要有对应的执行点。
 *
 * ## 找不到的 webContents 直接跳过
 *
 * 界面可能在两次广播之间被关掉。`fromId` 返回 undefined 或目标已销毁都是**正常情况**，
 * 不是错误 —— 顺手把归属摘掉，让表保持干净。
 */
export function broadcastSurfaceEvent(
  name: "theme" | "reload" | "config",
  payload: unknown,
  requiredPermission?: "ui.theme",
): number {
  const owners = getSurfaceOwners();
  const registry = getPluginRegistry();
  let delivered = 0;

  for (const [webContentsId, owner] of owners.entries()) {
    if (requiredPermission !== undefined) {
      const source = registry.enabledSources().find((entry) => entry.id === owner.pluginId);
      // 插件被停用 → 它的界面不该再收到任何东西（归属也会在停用流程里被摘掉）
      if (source === undefined) continue;
      if (!source.manifest.permissions.includes(requiredPermission)) continue;
    }

    const contents = webContents.fromId(webContentsId);
    if (contents === undefined || contents.isDestroyed()) {
      owners.release(webContentsId);
      continue;
    }
    contents.send(IPC.surface.event, { name, payload });
    delivered += 1;
  }
  return delivered;
}

export async function closePluginSurface(
  owner: SurfaceOwner,
  webContentsId: number,
): Promise<void> {
  const win = windows.get(keyOf(owner.pluginId, owner.surfaceId));
  if (win !== undefined && !win.isDestroyed() && win.webContents.id === webContentsId) {
    win.close();
  }
  /*
    宿主在渲染层的那两类（面板 / 模态窗）**不在这里关**：它们的宿主是 React 组件，
    主进程没有句柄。能做的有两件，顺序不能反：

      1. 先摘归属 —— 于是那个 guest 里的页面**立刻**失去调用宿主的能力，
         即使标签 / 对话框还开着（关闭是异步的，中间有一段窗口期）；
      2. 再告诉渲染层把标签 / 对话框收掉 —— 不通知的话，用户点了插件页面里的
         "关闭"之后界面照旧开着，而它此后每一次桥调用都被身份闸门拒掉：
         一个凭空的"点了没反应"。

    推给**所有窗口**而不是只给主窗口，与 bootstrap 里 emitSubagent 同款：
    插件界面自己的窗口没有订阅这个通道，收到即忽略；而"主窗口是哪一个"这件事
    在这里没有可靠的判据（`getMainWindow()` 会引入 window.ts ↔ 本文件 的循环依赖）。
  */
  getSurfaceOwners().release(webContentsId);
  if (owner.kind !== "window") {
    const event: PluginSurfaceClosedEvent = {
      pluginId: owner.pluginId,
      surfaceId: owner.surfaceId,
      kind: owner.kind,
    };
    for (const target of BrowserWindow.getAllWindows()) {
      if (!target.isDestroyed()) target.webContents.send(IPC.plugins.surfaceClosed, event);
    }
  }
}

/**
 * 关掉某个插件的全部界面。
 *
 * 停用 / 卸载插件时调用。**归属先摘再关窗**：反过来的话，窗口关闭是异步的，
 * 那个窗口期里页面还能发出几个调用进来。
 */
export function closeAllSurfacesOfPlugin(pluginId: string): number[] {
  const owners = getSurfaceOwners();
  const ids = owners.releasePlugin(pluginId);
  const closed: number[] = [];
  for (const [key, win] of [...windows]) {
    if (!key.startsWith(`${pluginId}/`)) continue;
    if (!win.isDestroyed()) win.close();
    windows.delete(key);
    closed.push(win.webContents.id);
  }
  return [...new Set([...ids, ...closed])];
}

/** 当前开着的插件窗口（诊断用） */
export function pluginWindowCount(): number {
  return windows.size;
}

/**
 * 给一个新建的 guest 登记归属 —— **宿主在渲染层的那两类界面**（面板与模态窗）走这条路。
 *
 * 这两种界面都是主渲染层里的 `<webview>`，主进程要到 `did-attach-webview` 才拿得到
 * 它的 webContents。**这是渲染层宿主与 `window` 唯一需要分叉的地方**：之后两者走
 * 完全一样的桥。（名字里的 renderer 就是这个意思：宿主在渲染层，而不是主进程建的窗口。）
 */
export function claimRendererSurface(contents: WebContents, owner: SurfaceOwner): void {
  /*
    渲染层宿主的 guest 是渲染层建的，所以主进程要到这一刻才拿得到它的 session。
    权限门装在这里，与窗口那条路装的是**同一个分区**（都按 pluginId 算），
    所以两边幂等、不会互相覆盖成不同的策略。
  */
  hardenPluginPartition(contents.session);
  getSurfaceOwners().claim(contents.id, owner);
  contents.on("destroyed", () => getSurfaceOwners().release(contents.id));
}

/**
 * 从一个 guest 的**分区**反查出它属于哪个插件，并登记归属。
 *
 * 这是 `window.ts` 在 `did-attach-webview` 时用的入口 —— 那里**不能**靠 `getURL()`：
 * guest 刚挂上时导航还没提交，URL 往往是空的，于是插件界面会被当成普通 webview，
 * 归属永远不登记，页面里每一次 `window.oint.*` 都被身份闸门挡掉。
 *
 * 分区在 attach 时一定就绪（渲染层建元素时就设了），而且它**本来就是**
 * "这个 webview 属于哪个插件"的权威来源 —— 存储隔离用的就是它。
 *
 * ## 身份按分区判，surfaceId 按 URL 补
 *
 * 分区里没有 surfaceId（它按插件算），而 attach 这一刻 URL 往往还是空的。所以：
 * 先用分区把**身份**登记上（安全相关的那一半 —— 页面第一次调用起就得是对的），
 * surfaceId 先取第一个渲染层界面**占位**；等主框架导航提交（`did-navigate`）后，
 * 按 URL 把它修正成真正的那一个。
 *
 * 只有**声明了多个**渲染层界面的插件才挂那个监听 —— 大多数插件只有一个，
 * 常见路径因此零额外开销。
 *
 * ⚠️ **修正这一步不是安全边界**：宿主所有桥接判据都只看 pluginId
 *（见 surface-owners.ts 的文件头），surfaceId 只用于记账与"关掉哪一个"。
 * 所以"先占位、后修正"是允许的；反过来（等 URL 到位再登记）会让页面最初的
 * 几次调用被身份闸门拒绝。
 *
 * 返回是否登记成功；失败时调用方应当按普通 webview 处理（而不是静默放行）。
 */
export function claimSurfaceBySession(contents: WebContents): boolean {
  const registry = getPluginRegistry();
  /*
    **按 session 的对象身份反查，而不是比分区字符串。**

    Electron 的 `Session.getPartition()` 不在类型里（运行时也许有，但靠不住）。
    而 `session.fromPartition(p)` 对同一个分区**返回同一个对象** ——
    这个身份比较是 API 保证的，比解析字符串更可靠。
  */
  const source = registry
    .enabledSources()
    .find((candidate) => session.fromPartition(pluginPartition(candidate.id)) === contents.session);
  if (source === undefined) return false;

  /*
    宿主在渲染层的界面 = 面板与模态窗（`window` 由主进程建窗，不走这条路）。
    挑选规则在 surface-decls.ts 里（纯函数、有单测）：这里只负责"拿它填归属"。
  */
  const declared = rendererSurfaces(source.manifest.surfaces);

  /*
    attach 这一刻 URL 往往是空的，所以先按第一个占位（身份才是安全相关的那一半）。
    `undefined` 只有一种来源：这个插件的界面全是独立窗口 —— 那不是渲染层宿主的 guest，
    调用方应当按普通 webview 处理（返回 false）。
  */
  const surface = surfaceByUrl(source.id, declared, contents.getURL()) ?? declared[0];
  if (surface === undefined) return false;

  claimRendererSurface(contents, {
    pluginId: source.id,
    surfaceId: surface.id,
    kind: surface.kind,
  });

  if (declared.length <= 1) return true;

  // 多个渲染层界面：按 URL 把 surfaceId 修正成真正加载的那一个
  contents.on("did-navigate", (_event, url) => {
    const hit = surfaceByUrl(source.id, declared, url);
    if (hit === undefined) return;
    const current = getSurfaceOwners().ownerOf(contents.id);
    if (current === undefined || current.surfaceId === hit.id) return;
    getSurfaceOwners().claim(contents.id, {
      pluginId: source.id,
      surfaceId: hit.id,
      kind: hit.kind,
    });
  });
  return true;
}
