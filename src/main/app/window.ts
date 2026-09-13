import path from "node:path";
import { BrowserWindow } from "electron";
import { IPC } from "@/shared/contracts/ipc";

let mainWindow: BrowserWindow | null = null;

/** 供 IPC 处理器获取当前主窗口；窗口可能已销毁 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

function notifyMaximized(win: BrowserWindow): void {
  if (!win.isDestroyed()) {
    win.webContents.send(IPC.window.onMaximizedChange, win.isMaximized());
  }
}

/**
 * 内置浏览器（<webview>）的安全策略。
 *
 * webviewTag 打开后，渲染层可以嵌入任意页面 —— 那是「浏览器」面板的功能，
 * 但也意味着 guest 的能力必须被收死。这里做两件事，缺一不可：
 *
 *   1. will-attach-webview：抹掉 guest 的 preload、关掉 nodeIntegration，
 *      强制 contextIsolation + sandbox。渲染层即使想给 webview 塞 preload 也塞不进来。
 *   2. did-attach-webview：把 guest 的 window.open / target="_blank" 全部拒掉 ——
 *      内置浏览器不该能自己弹新窗口（弹出来的是无人管理的裸窗口）。
 *
 * 刻意**不做**域名 allow-list：面板是给人用的通用浏览器，限制域名会让它失去意义。
 * 真正的边界是「guest 没有 Node 能力、不能弹窗、拿不到我们的 preload」。
 */
function hardenWebviews(win: BrowserWindow): void {
  win.webContents.on("will-attach-webview", (_event, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  win.webContents.on("did-attach-webview", (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  });
}

export function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    frame: false, // 自绘标题栏
    show: false,
    // 主题令牌落地前先给深色底，避免首帧白闪；checkpoint-2 接设置项
    backgroundColor: "#121212",
    webPreferences: {
      // 构建产物为 dist-electron/preload.cjs；sandbox 不支持 ESM preload
      preload: path.join(import.meta.dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      /*
        内置浏览器面板需要 <webview>。实测 sandbox: true 与 webviewTag 可以共存
        （guest 页面照常加载、did-attach 钩子照常触发），所以主窗口的 sandbox 不放松。
        光开这个开关等于给了渲染层任意嵌页面的能力，配套的收紧见 hardenWebviews()。
      */
      webviewTag: true,
    },
  });

  hardenWebviews(win);

  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => notifyMaximized(win));
  win.on("unmaximize", () => notifyMaximized(win));
  win.on("closed", () => {
    mainWindow = null;
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    void win.loadURL(devServerUrl);
  } else {
    void win.loadFile(path.join(import.meta.dirname, "../dist/index.html"));
  }

  mainWindow = win;
  return win;
}
