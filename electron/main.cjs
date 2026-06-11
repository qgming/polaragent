// 主进程入口：应用生命周期、IPC 注册汇总。
// 各域处理器拆分至 ipc/*，共享工具拆分至 lib/*。
const { app, BrowserWindow, ipcMain } = require("electron");

const { APP_ID, APP_NAME } = require("./lib/constants.cjs");
const { ensureDataDir } = require("./lib/app-paths.cjs");
const { createMainWindow } = require("./lib/windows.cjs");

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
  require("./ipc/knowledge.cjs"),
  require("./ipc/cli-detect.cjs"),
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
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
