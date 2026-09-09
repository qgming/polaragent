// 主进程入口：应用生命周期、IPC 注册汇总。
// 各域处理器拆分至 ipc/*，共享工具拆分至 lib/*。
import { app, BrowserWindow, ipcMain, session } from "electron";

import { register as registerAppWindow } from "./ipc/app-window.js";
import { register as registerBrowserUse } from "./ipc/browseruse.js";
import { register as registerCliDetect } from "./ipc/cli-detect.js";
import { register as registerComputerUse } from "./ipc/computeruse.js";
import { register as registerConfig } from "./ipc/config.js";
import { register as registerFs } from "./ipc/fs.js";
import { register as registerKnowledge } from "./ipc/knowledge.js";
import { register as registerLlm } from "./ipc/llm.js";
import { register as registerMcp } from "./ipc/mcp.js";
import { register as registerMemory } from "./ipc/memory.js";
import { register as registerNetwork } from "./ipc/network.js";
import { register as registerOffice } from "./ipc/office.js";
import { register as registerShell } from "./ipc/shell.js";
import { register as registerSkills } from "./ipc/skills.js";
import { register as registerUpdates, initializeAutoUpdates } from "./ipc/updates.js";
import { ensureDataDir, readSettingCloseToTray, readSettingStartInSystemTray } from "./lib/app-paths.js";
import { APP_ID, APP_NAME } from "./lib/constants.js";
import { installSessionSecurity } from "./lib/session-security.js";
import { createTray, destroyTray, setIsQuitting } from "./lib/tray.js";
import { createMainWindow, getMainWindow } from "./lib/windows.js";

const ipcRegistrars = [
  registerAppWindow,
  registerFs,
  registerConfig,
  registerLlm,
  registerNetwork,
  registerSkills,
  registerMcp,
  registerShell,
  registerOffice,
  registerKnowledge,
  registerMemory,
  registerCliDetect,
  registerComputerUse,
  registerBrowserUse,
  registerUpdates,
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
    const closeToTray = readSettingCloseToTray();
    const startInTray = readSettingStartInSystemTray();
    createMainWindow({ closeToTray, startInTray });
    createTray();
    initializeAutoUpdates();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow({ closeToTray: readSettingCloseToTray(), startInTray: false });
      }
    });
  });
}

// hide 的窗口不会触发此事件，仅真正销毁后才触发。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  setIsQuitting(true);
});

app.on("will-quit", () => {
  destroyTray();
});
