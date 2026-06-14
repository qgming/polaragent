const { app, autoUpdater, dialog, shell } = require("electron");

const { APP_NAME } = require("../lib/constants.cjs");
const { getMainWindow } = require("../lib/windows.cjs");

const UPDATE_OWNER = process.env.POLARAGENT_UPDATE_OWNER || "qgming";
const UPDATE_REPO = process.env.POLARAGENT_UPDATE_REPO || "polaragent";
const UPDATE_REPOSITORY = `${UPDATE_OWNER}/${UPDATE_REPO}`;
const UPDATE_FEED_BASE_URL = (process.env.POLARAGENT_UPDATE_FEED_URL || "https://update.electronjs.org").replace(/\/+$/, "");
const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32"]);
const ENABLE_DEV_UPDATES = process.env.POLARAGENT_ENABLE_DEV_UPDATES === "1";
const AUTO_CHECK_DELAY_MS = Number.parseInt(process.env.POLARAGENT_UPDATE_CHECK_DELAY_MS || "3000", 10);
const AUTO_CHECK_INTERVAL_MS = Number.parseInt(process.env.POLARAGENT_UPDATE_CHECK_INTERVAL_MS || "600000", 10);

let configured = false;
let eventsBound = false;
let autoCheckTimer = null;

let updateStatus = createBaseStatus();

function isSupportedPlatform() {
  return SUPPORTED_PLATFORMS.has(process.platform);
}

function isUpdateEnabled() {
  return isSupportedPlatform() && (app.isPackaged || ENABLE_DEV_UPDATES);
}

function getFeedUrl() {
  return `${UPDATE_FEED_BASE_URL}/${UPDATE_REPOSITORY}/${process.platform}-${process.arch}/${app.getVersion()}`;
}

function getInitialPhase() {
  if (!isSupportedPlatform()) return "unsupported";
  if (!app.isPackaged && !ENABLE_DEV_UPDATES) return "disabled";
  return "idle";
}

function getInitialMessage() {
  if (!isSupportedPlatform()) return "当前平台不支持 Electron 官方自动更新";
  if (!app.isPackaged && !ENABLE_DEV_UPDATES) return "开发环境不会连接更新服务";
  return "准备检查更新";
}

function createBaseStatus() {
  return {
    phase: getInitialPhase(),
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    supported: isSupportedPlatform(),
    enabled: isUpdateEnabled(),
    updateAvailable: false,
    downloaded: false,
    repository: UPDATE_REPOSITORY,
    feedUrl: isSupportedPlatform() ? getFeedUrl() : null,
    releasesUrl: RELEASES_URL,
    message: getInitialMessage(),
    error: null,
    releaseName: null,
    releaseDate: null,
    updateUrl: null,
  };
}

function cloneStatus() {
  return { ...updateStatus };
}

function broadcastStatus() {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("updates:status", cloneStatus());
  }
}

function setStatus(next) {
  updateStatus = {
    ...updateStatus,
    ...next,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    supported: isSupportedPlatform(),
    enabled: isUpdateEnabled(),
    repository: UPDATE_REPOSITORY,
    feedUrl: isSupportedPlatform() ? getFeedUrl() : null,
    releasesUrl: RELEASES_URL,
  };
  broadcastStatus();
  return cloneStatus();
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "未知错误");
}

function bindAutoUpdaterEvents() {
  if (eventsBound) return;
  eventsBound = true;

  autoUpdater.on("checking-for-update", () => {
    setStatus({
      phase: "checking",
      updateAvailable: false,
      downloaded: false,
      message: "正在检查更新",
      error: null,
    });
  });

  autoUpdater.on("update-available", () => {
    setStatus({
      phase: "available",
      updateAvailable: true,
      downloaded: false,
      message: "发现新版本，正在后台下载",
      error: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setStatus({
      phase: "not-available",
      updateAvailable: false,
      downloaded: false,
      message: "当前已是最新版本",
      error: null,
    });
  });

  autoUpdater.on("update-downloaded", (_event, releaseNotes, releaseName, releaseDate, updateUrl) => {
    setStatus({
      phase: "downloaded",
      updateAvailable: true,
      downloaded: true,
      releaseName: releaseName || null,
      releaseDate: releaseDate || null,
      updateUrl: updateUrl || null,
      message: "新版本已下载，重启后完成安装",
      error: null,
    });
    void promptToInstall(releaseName, releaseNotes);
  });

  autoUpdater.on("error", (error) => {
    setStatus({
      phase: "error",
      updateAvailable: false,
      downloaded: false,
      message: "更新检查失败",
      error: errorMessage(error),
    });
  });
}

async function promptToInstall(releaseName, releaseNotes) {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;

  const result = await dialog.showMessageBox(win, {
    type: "info",
    title: "发现新版本",
    message: `${APP_NAME} ${releaseName || "新版本"} 已准备好`,
    detail: typeof releaseNotes === "string" && releaseNotes.trim()
      ? releaseNotes
      : "重启应用后完成更新安装。",
    buttons: ["稍后", "重启安装"],
    defaultId: 1,
    cancelId: 0,
  });

  if (result.response === 1) {
    autoUpdater.quitAndInstall();
  }
}

function ensureConfigured() {
  if (configured) return true;
  if (!isSupportedPlatform()) {
    setStatus({
      phase: "unsupported",
      message: "当前平台不支持 Electron 官方自动更新",
      error: null,
    });
    return false;
  }
  if (!app.isPackaged && !ENABLE_DEV_UPDATES) {
    setStatus({
      phase: "disabled",
      message: "开发环境不会连接更新服务",
      error: null,
    });
    return false;
  }

  const feedOptions = { url: getFeedUrl() };
  if (process.platform === "darwin") {
    feedOptions.serverType = "json";
  }
  autoUpdater.setFeedURL(feedOptions);
  bindAutoUpdaterEvents();
  configured = true;
  setStatus({ phase: "idle", message: "准备检查更新", error: null });
  return true;
}

function checkForUpdates() {
  if (!ensureConfigured()) return cloneStatus();
  setStatus({
    phase: "checking",
    updateAvailable: false,
    downloaded: false,
    message: "正在检查更新",
    error: null,
  });
  try {
    autoUpdater.checkForUpdates();
  } catch (error) {
    setStatus({
      phase: "error",
      updateAvailable: false,
      downloaded: false,
      message: "更新检查失败",
      error: errorMessage(error),
    });
  }
  return cloneStatus();
}

function initializeAutoUpdates() {
  if (!ensureConfigured()) return cloneStatus();
  if (autoCheckTimer) return cloneStatus();

  const delayMs = Number.isFinite(AUTO_CHECK_DELAY_MS) ? Math.max(AUTO_CHECK_DELAY_MS, 0) : 3000;
  const intervalMs = Number.isFinite(AUTO_CHECK_INTERVAL_MS)
    ? Math.max(AUTO_CHECK_INTERVAL_MS, 60000)
    : 600000;

  setTimeout(() => {
    checkForUpdates();
    autoCheckTimer = setInterval(checkForUpdates, intervalMs);
    if (typeof autoCheckTimer.unref === "function") autoCheckTimer.unref();
  }, delayMs).unref?.();

  return cloneStatus();
}

function installUpdate() {
  if (!updateStatus.downloaded) {
    throw new Error("更新尚未下载完成");
  }
  autoUpdater.quitAndInstall();
  return cloneStatus();
}

function register(ipcMain) {
  ipcMain.handle("updates:get-status", () => cloneStatus());
  ipcMain.handle("updates:check", () => checkForUpdates());
  ipcMain.handle("updates:install", () => installUpdate());
  ipcMain.handle("updates:open-releases", async () => shell.openExternal(RELEASES_URL));
}

module.exports = {
  initializeAutoUpdates,
  register,
};
