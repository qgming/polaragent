import { app, BrowserWindow } from "electron";
import { IPC } from "@/shared/contracts/ipc";
import { ensureAppDirs } from "./app/paths";
import { createMainWindow, getMainWindow } from "./app/window";
import { registerIpcHandlers } from "./ipc/registry";
import { bootstrapPisdk } from "./pisdk/bootstrap";
import { disposeTerminalService } from "./terminal/service";

// 单实例锁：SQLite 会话库与窗口状态都不允许并发写
const gotSingleInstanceLock = app.requestSingleInstanceLock();

// pisdk 清理函数：退出前统一释放运行时与 sqlite 资源
let disposePisdk: (() => void) | null = null;

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  // IPC 先注册再建窗口，保证渲染进程首帧调用即可用
  registerIpcHandlers();

  void app.whenReady().then(() => {
    ensureAppDirs();
    // 装配 pisdk 并把聊天事件广播到所有窗口
    disposePisdk = bootstrapPisdk({
      emit: (event) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send(IPC.chat.event, event);
        }
      },
    });
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

// 退出前释放 pisdk 与终端；清理函数幂等，重复触发安全。
// 终端必须显式杀掉：PTY 的 shell（以及它前台挂着的子进程）不清理会留下孤儿进程占着端口。
app.on("before-quit", () => {
  disposeTerminalService();
  disposePisdk?.();
  disposePisdk = null;
});

// macOS 下关闭窗口不退出应用，其余平台沿用系统习惯
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
