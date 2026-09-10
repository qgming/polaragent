// 主进程入口：应用生命周期、IPC 注册汇总。
// 各域处理器拆分至 ipc/*，共享工具拆分至 lib/*。
import { app, BrowserWindow, ipcMain, session } from "electron";

import { register as registerAppWindow } from "./ipc/app-window.js";
import { register as registerConfig } from "./ipc/config.js";
import { register as registerFs } from "./ipc/fs.js";
import { register as registerLlm } from "./ipc/llm.js";
import { register as registerNetwork } from "./ipc/network.js";
import { register as registerShell } from "./ipc/shell.js";
import { ensureDataDir } from "./lib/app-paths.js";
import { APP_ID, APP_NAME } from "./lib/constants.js";
import { installSessionSecurity } from "./lib/session-security.js";
import { createMainWindow, getMainWindow } from "./lib/windows.js";

const ipcRegistrars = [
  registerAppWindow,
  registerFs,
  registerConfig,
  registerLlm,
  registerNetwork,
  registerShell,
];

// 注册全部 IPC 处理器
function registerHandlers() {
  for (const register of ipcRegistrars) register(ipcMain);
}

app.setAppUserModelId(APP_ID);
app.setName(APP_NAME);

const gotSingleInstanceLock = app.requestSingleInstanceLock();

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

  registerHandlers();
  void app.whenReady().then(async () => {
    installSessionSecurity(session.defaultSession, {
      devServerUrl: process.env.VITE_DEV_SERVER_URL ?? null,
    });
    await ensureDataDir();
    createMainWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

// hide 的窗口不会触发此事件，仅真正销毁后才触发。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
