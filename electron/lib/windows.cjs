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
// - closeToTray: 关闭时隐藏到托盘而非退出（默认 true）
// - startInTray: 启动时不显示窗口，仅显示托盘图标（默认 false）
function createMainWindow({ closeToTray = true, startInTray = false } = {}) {
  mainWindow = createWindow({
    width: 1000,    // 默认宽度：1240 → 1000 (适配主流软件标准)
    height: 700,    // 默认高度：820 → 700 (保持16:9舒适比例)
    minWidth: 600,  // 最小宽度：860 → 600 (双屏/三分屏友好)
    minHeight: 450, // 最小高度：560 → 450 (保持纵横比)
    title: APP_NAME,
    _skipShow: startInTray, // 内部选项：启动时不显示窗口
  });
  loadApp(mainWindow);

  // 关闭拦截：closeToTray 且非真正退出时 → 隐藏窗口到托盘
  mainWindow.on("close", (event) => {
    const { getIsQuitting } = require("./tray.cjs");
    const { readSettingCloseToTray } = require("./app-paths.cjs");
    // 每次动态读取配置，确保设置变更立即生效（无重启）
    if (readSettingCloseToTray() && !getIsQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  return mainWindow;
}

// 通用无边框窗口创建；监听窗口最大化状态变化并广播给渲染进程
function createWindow(options) {
  const { _skipShow, ...windowOptions } = options; // 提取内部选项，不传给 BrowserWindow
  const icon = appIconPath();
  const win = new BrowserWindow({
    ...windowOptions,
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

  win.once("ready-to-show", () => {
    if (!_skipShow) win.show();
  });
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
