// 插件界面的 guest preload：把 `window.oint` 注入到插件的页面里。
//
// ## 这是宿主与第三方代码之间**唯一**的那道门
//
// 有别于主渲染层的 preload（src/preload/index.ts，暴露 ~70 个方法给**我们自己的**代码），
// 这一份暴露给的是**第三方写的页面**。所以口径完全不同：
//
//  - **没有任何方法接受 pluginId**。插件是谁由主进程按 `event.sender.id` 查归属表
//    得出（见 main/plugins/surface-owners.ts）。让插件自报身份是这类桥最经典的漏洞；
//  - **通道名全部走 `IPC.surface.*`**，与主渲染层不重名 —— 否则插件界面能直接调
//    `window.oint` 那一套（那里面有 settings.write、sessions.delete）；
//  - **不暴露 `ipcRenderer` 本身**。哪怕只是"给个通用 invoke"，插件就能试所有通道名，
//    而"试"这件事在本地没有速率限制。
//
// ## 为什么 sandbox 仍然是 true
//
// 沙箱化的 preload **仍然能拿到 `ipcRenderer` 与 `contextBridge`**（Electron 20+）。
// 也就是说"给插件界面装一个 preload"并不需要放弃沙箱 —— 这一点很容易被想反，
// 从而以为"要么没 preload、要么关沙箱"。两者都不必。
//
// ## 这个文件被打包成 plugin-surface.cjs
//
// sandbox: true 的窗口只支持 CJS preload，所以 vite.renderer.config.ts 里
// preload 段产出的是 `.cjs`（两个入口共用同一条规则）。

import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@/shared/contracts/ipc";
import type {
  OintSurfaceApi,
  SurfaceEventName,
  SurfaceInfo,
  SurfaceStoredValue,
} from "@/shared/contracts/surface";

/**
 * 界面自己的信息，由宿主在 **webPreferences.additionalArguments** 里传进来。
 *
 * 为什么不用 URL 查询串（那是最自然的做法）：`parseSurfaceUrl` **刻意拒绝**带查询串的
 * URL（见 surface-url.ts 的说明）—— 那一条是为了让"资源 URL"只有一种形状。
 * 而 `additionalArguments` 是 Electron 给 preload 传参的正规通道，且**页面读不到**
 *（它在 preload 进程的参数里，不在 `window.location` 上）。
 */
function readInfo(): SurfaceInfo {
  const prefix = "--oint-surface=";
  const raw = process.argv.find((argument) => argument.startsWith(prefix));
  const fallback: SurfaceInfo = {
    pluginId: "",
    surfaceId: "",
    kind: "panel",
    pluginName: "",
    theme: "light",
  };
  /*
    ⚠️ 走到兜底值不是"正常情况"：渲染层宿主的界面（面板 / 模态窗）的 guest 是渲染层建的，
    参数必须由主进程在 `will-attach-webview` 里补上（见 surfaces.ts 的 surfaceArgumentsForUrl）。
    漏了那一步的症状很隐蔽 —— 桥照常工作（身份来自 event.sender.id），只有这个
    "自我介绍"是空的，而主题会回落到 light（深色用户看到一块亮面板）。
    这条是被 `probe:plugin-modal` 抓出来的。
  */
  if (raw === undefined) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(raw.slice(prefix.length)) as Partial<SurfaceInfo>) };
  } catch {
    return fallback;
  }
}

const info = readInfo();

/**
 * 事件订阅表。
 *
 * preload 里留一份，因为 `ipcRenderer.on` 的监听器是**按通道**挂的，
 * 而插件按**事件名**订阅。不做这一层映射的话，每个插件订阅都会往同一个通道
 * 加一个监听器，而 Electron 对单个通道的监听器数量有上限（超过会打警告并可能丢弃）。
 */
const listeners = new Map<SurfaceEventName, Set<(payload: unknown) => void>>();
let bridgeAttached = false;
let bridgeDetached: (() => void) | null = null;

function attachBridge(): void {
  if (bridgeAttached) return;
  bridgeAttached = true;
  bridgeDetached = () => {
    ipcRenderer.removeAllListeners(IPC.surface.event);
    bridgeAttached = false;
    bridgeDetached = null;
  };

  ipcRenderer.on(
    IPC.surface.event,
    (_event, payload: { name: SurfaceEventName; payload: unknown }) => {
      const set = listeners.get(payload.name);
      if (set === undefined) return;
      for (const handler of set) {
        /*
        单个订阅者抛错不能让其它订阅者收不到 —— 而且**必须吞掉**：
        这个回调跑在 preload 的上下文里，未捕获的异常会影响整个桥。
        插件自己的 bug 不该让宿主与它的通道一起坏掉。
      */
        try {
          handler(payload.payload);
        } catch {
          /* 插件的处理器自己出错，与桥无关 */
        }
      }
    },
  );
}

/** 调用一个宿主通道；失败时把主进程的错误原文带出去 */
function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args) as Promise<T>;
}

const api: OintSurfaceApi = {
  info,

  ready: () => invoke<void>(IPC.surface.ready),
  close: () => invoke<void>(IPC.surface.close),

  storage: {
    get: (key) => invoke<SurfaceStoredValue | undefined>(IPC.surface.storageGet, key),
    set: (key, value) => invoke<void>(IPC.surface.storageSet, key, value),
    delete: (key) => invoke<void>(IPC.surface.storageDelete, key),
    keys: () => invoke<string[]>(IPC.surface.storageKeys),
  },

  on(name, handler) {
    attachBridge();
    let set = listeners.get(name);
    if (set === undefined) {
      set = new Set();
      listeners.set(name, set);
    }
    set.add(handler);

    return () => {
      const current = listeners.get(name);
      if (current === undefined) return;
      current.delete(handler);
      // 一个订阅者都不剩时把整条桥摘掉，而不是留一个空监听器
      if (current.size === 0) listeners.delete(name);
      if (listeners.size === 0) bridgeDetached?.();
    };
  },

  fetch: (url, init) => invoke(IPC.surface.fetch, url, init ?? {}),
  writeText: (text) => invoke<void>(IPC.surface.writeText, text),
  workspace: () => invoke<string>(IPC.surface.workspace),
  exec: (command, args, options) => invoke(IPC.surface.exec, command, args ?? [], options ?? {}),
  notify: (title, body) => invoke<void>(IPC.surface.notify, title, body),
};

/*
  暴露成 `window.oint` —— **与主渲染层同名**。

  这是刻意的：同一个产品里两个 `window.oint` 长得不一样会让人困惑，而插件作者
  看到的 `window.oint` 就该是"宿主给我的能力"。两者形状不同是**权限**的区别，
  不是命名的区别 —— 插件界面拿不到的那几十个方法，本来也不该出现在它面前。

  `exposeInMainWorld` 而不是直接挂 `window.oint = api`：后者在 contextIsolation
  下写的是 preload 自己的 world，页面看不到。
*/
contextBridge.exposeInMainWorld("oint", api);
