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
    },
  });

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
