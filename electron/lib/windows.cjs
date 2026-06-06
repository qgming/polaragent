// 窗口管理：主窗口创建、通用窗口创建、应用加载。
// 持有 mainWindow 引用，供主进程与各 ipc 模块通过 getMainWindow() 访问。
const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const { APP_NAME } = require("./constants.cjs");
const { appIconPath } = require("./app-paths.cjs");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:1420";

let mainWindow;

// 当前主窗口（可能为 undefined）
function getMainWindow() {
  return mainWindow;
}

// 创建并加载主窗口
function createMainWindow() {
  mainWindow = createWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: APP_NAME,
  });
  loadApp(mainWindow);
  return mainWindow;
}

// 通用无边框窗口创建；监听窗口最大化状态变化并广播给渲染进程
function createWindow(options) {
  const icon = appIconPath();
  const win = new BrowserWindow({
    ...options,
    ...(icon ? { icon } : {}),
    titleBarStyle: "hidden",
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  const notifyMaximized = () => win.webContents.send("window:maximized-change", win.isMaximized());
  win.on("maximize", notifyMaximized);
  win.on("unmaximize", notifyMaximized);
  win.on("resize", notifyMaximized);
  return win;
}

// 加载应用入口：开发环境走 dev server，生产环境加载打包后的 index.html
function loadApp(win, query = "") {
  if (isDev) {
    win.loadURL(`${DEV_URL}${query}`);
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist", "index.html"), query ? { query: parseQuery(query) } : undefined);
  }
}

// 把 query string 解析为对象，供 loadFile 的 query 选项使用
function parseQuery(query) {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  return Object.fromEntries(params.entries());
}

module.exports = {
  getMainWindow,
  createMainWindow,
  createWindow,
  loadApp,
};
