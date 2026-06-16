// 系统托盘：图标、右键菜单、左键恢复窗口、退出标志管理
const { Tray, Menu, nativeImage, app } = require("electron");
const { getMainWindow } = require("./windows.cjs");
const { projectResourcePath } = require("./app-paths.cjs");
const { APP_NAME } = require("./constants.cjs");

let tray = null;
let isQuitting = false;

// 托盘图标路径（回退到应用图标）
function trayIconPath() {
  return (
    projectResourcePath("build", "icon.ico") ||
    projectResourcePath("build", "icon.png") ||
    projectResourcePath("dist", "logo.png") ||
    projectResourcePath("public", "logo.png")
  );
}

// 创建系统托盘图标及上下文菜单
function createTray() {
  const iconPath = trayIconPath();
  if (!iconPath) return;

  const icon = nativeImage.createFromPath(iconPath);
  // Windows 托盘标准尺寸 16x16；大图缩小以适配
  const trayIcon = icon.getSize().width > 16
    ? icon.resize({ width: 16, height: 16 })
    : icon;

  tray = new Tray(trayIcon);
  tray.setToolTip(APP_NAME);

  // 右键上下文菜单
  const contextMenu = Menu.buildFromTemplate([
    { label: "显示主窗口", click: showMainWindow },
    { type: "separator" },
    { label: "退出软件", click: quitApp },
  ]);
  tray.setContextMenu(contextMenu);

  // 左键点击：恢复并聚焦主窗口
  tray.on("click", showMainWindow);
}

// 恢复并聚焦主窗口
function showMainWindow() {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// 从托盘菜单完全退出应用
function quitApp() {
  isQuitting = true;
  app.quit();
}

function getIsQuitting() {
  return isQuitting;
}

function setIsQuitting(value) {
  isQuitting = value;
}

// 退出时销毁托盘，防止 Windows 上图标残留
function destroyTray() {
  if (tray && !tray.isDestroyed()) {
    tray.destroy();
    tray = null;
  }
}

module.exports = {
  createTray,
  destroyTray,
  showMainWindow,
  getIsQuitting,
  setIsQuitting,
  quitApp,
};
