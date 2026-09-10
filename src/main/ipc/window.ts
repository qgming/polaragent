import { BrowserWindow, ipcMain } from "electron";
import { IPC } from "@/shared/contracts/ipc";

// 从事件来源反查窗口，避免处理器持有全局引用
function withWindow(handler: (win: BrowserWindow) => void) {
  return (event: Electron.IpcMainInvokeEvent): void => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) handler(win);
  };
}

export function registerWindowIpc(): void {
  ipcMain.handle(
    IPC.window.minimize,
    withWindow((win) => win.minimize()),
  );
  ipcMain.handle(
    IPC.window.toggleMaximize,
    withWindow((win) => {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }),
  );
  ipcMain.handle(
    IPC.window.close,
    withWindow((win) => win.close()),
  );
}
