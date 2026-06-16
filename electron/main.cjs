// 主进程入口：应用生命周期、IPC 注册汇总。
// 各域处理器拆分至 ipc/*，共享工具拆分至 lib/*。
const { app, BrowserWindow, ipcMain } = require("electron");

const { APP_ID, APP_NAME } = require("./lib/constants.cjs");
const { ensureDataDir, readSettingCloseToTray, readSettingStartInSystemTray } = require("./lib/app-paths.cjs");
const { createMainWindow } = require("./lib/windows.cjs");
const { createTray, destroyTray, setIsQuitting } = require("./lib/tray.cjs");
const updates = require("./ipc/updates.cjs");

// 各 IPC 域模块（均导出 register(ipcMain)）
const ipcModules = [
  require("./ipc/app-window.cjs"),
  require("./ipc/fs.cjs"),
  require("./ipc/config.cjs"),
  require("./ipc/llm.cjs"),
  require("./ipc/network.cjs"),
  require("./ipc/skills.cjs"),
  require("./ipc/mcp.cjs"),
  require("./ipc/shell.cjs"),
  require("./ipc/office.cjs"),
  require("./ipc/knowledge.cjs"),
  require("./ipc/cli-detect.cjs"),
  require("./ipc/computeruse.cjs"),
  require("./ipc/browseruse.cjs"),
  updates,
];

// 注册全部 IPC 处理器
function registerHandlers() {
  for (const mod of ipcModules) mod.register(ipcMain);
}

app.setAppUserModelId(APP_ID);
app.setName(APP_NAME);
registerHandlers();
app.whenReady().then(async () => {
  await ensureDataDir();
  const closeToTray = readSettingCloseToTray();
  const startInTray = readSettingStartInSystemTray();
  createMainWindow({ closeToTray, startInTray });
  createTray();
  updates.initializeAutoUpdates();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow({ closeToTray: readSettingCloseToTray(), startInTray: false });
    }
  });
});

// window-all-closed：hide 的窗口不会触发此事件，仅真正销毁后才触发
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 任何形式的 app.quit() 都标记为真正退出（托盘菜单 / 自动更新 / 系统关机）
app.on("before-quit", () => {
  setIsQuitting(true);
});

// 退出时销毁托盘，防止 Windows 上图标残留
app.on("will-quit", () => {
  destroyTray();
});
