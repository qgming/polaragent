const { app, shell } = require("electron");
const { autoUpdater } = require("electron-updater");

const { APP_NAME } = require("../lib/constants.cjs");
const { getMainWindow } = require("../lib/windows.cjs");

const UPDATE_OWNER = process.env.POLARAGENT_UPDATE_OWNER || "qgming";
const UPDATE_REPO = process.env.POLARAGENT_UPDATE_REPO || "polaragent";
const UPDATE_REPOSITORY = `${UPDATE_OWNER}/${UPDATE_REPO}`;
const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
const LATEST_RELEASE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;
const SUPPORTED_PLATFORMS = new Set(["darwin", "win32", "linux"]);
const ENABLE_DEV_UPDATES = process.env.POLARAGENT_ENABLE_DEV_UPDATES === "1";
const AUTO_CHECK_DELAY_MS = Number.parseInt(process.env.POLARAGENT_UPDATE_CHECK_DELAY_MS || "3000", 10);
const AUTO_CHECK_INTERVAL_MS = Number.parseInt(process.env.POLARAGENT_UPDATE_CHECK_INTERVAL_MS || "21600000", 10);
const RELEASE_CACHE_TTL_MS = Number.parseInt(process.env.POLARAGENT_RELEASE_CACHE_TTL_MS || "300000", 10);

let configured = false;
let eventsBound = false;
let autoCheckTimer = null;
let latestReleaseCache = null;
let latestReleaseFetchedAt = 0;
let latestReleaseRequest = null;

let updateStatus = createBaseStatus();

function isSupportedPlatform() {
  return SUPPORTED_PLATFORMS.has(process.platform);
}

function isUpdateEnabled() {
  return isSupportedPlatform() && (app.isPackaged || ENABLE_DEV_UPDATES);
}

function getInitialPhase() {
  if (!isSupportedPlatform()) return "unsupported";
  if (!app.isPackaged && !ENABLE_DEV_UPDATES) return "disabled";
  return "idle";
}

function getInitialMessage() {
  if (!isSupportedPlatform()) return "当前平台不支持自动更新";
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
    feedUrl: null, // electron-updater 使用 GitHub Releases，不需要 feedUrl
    releasesUrl: RELEASES_URL,
    message: getInitialMessage(),
    error: null,
    latestVersion: null,
    latestTag: null,
    releaseName: null,
    releaseDate: null,
    releaseUrl: null,
    releaseNotes: null,
    releaseNotesError: null,
    updateUrl: null,
    triggeredBy: null, // "auto" | "manual" | null
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
    feedUrl: null,
    releasesUrl: RELEASES_URL,
  };
  broadcastStatus();
  return cloneStatus();
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error || "未知错误");
}

function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === "string") return releaseNotes.trim() || null;
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          return [item.version, item.note].filter(Boolean).join("\n\n");
        }
        return "";
      })
      .filter(Boolean)
      .join("\n\n")
      .trim() || null;
  }
  return null;
}

function normalizeTag(version) {
  if (!version) return null;
  const value = String(version).trim();
  return value ? (value.startsWith("v") ? value : `v${value}`) : null;
}

function normalizeVersion(version) {
  return String(version || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split("+")[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length, 3);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] || 0;
    const rightPart = rightParts[index] || 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

function getUpdateUrl(updateInfo) {
  if (!updateInfo || typeof updateInfo !== "object") return null;
  if (typeof updateInfo.path === "string" && updateInfo.path.trim()) return updateInfo.path;
  if (Array.isArray(updateInfo.files)) {
    const file = updateInfo.files.find((item) => item && typeof item.url === "string" && item.url.trim());
    if (file) return file.url;
  }
  return null;
}

function updateStatusFromUpdaterInfo(updateInfo) {
  if (!updateInfo || typeof updateInfo !== "object") return {};

  const latestVersion = updateInfo.version ? normalizeVersion(updateInfo.version) : null;
  const latestTag = normalizeTag(updateInfo.version);
  const releaseNotes = normalizeReleaseNotes(updateInfo.releaseNotes);

  return {
    latestVersion: latestVersion || updateStatus.latestVersion,
    latestTag: latestTag || updateStatus.latestTag,
    releaseName: updateInfo.releaseName || latestTag || updateStatus.releaseName,
    releaseDate: updateInfo.releaseDate || updateStatus.releaseDate,
    releaseNotes: releaseNotes || updateStatus.releaseNotes,
    updateUrl: getUpdateUrl(updateInfo) || updateStatus.updateUrl,
  };
}

function createReleaseStatus(release) {
  const latestVersion = normalizeVersion(release.tagName);
  const hasUpdate = compareVersions(latestVersion, app.getVersion()) > 0;

  return {
    latestVersion,
    latestTag: release.tagName,
    releaseName: release.name || release.tagName,
    releaseDate: release.publishedAt || release.createdAt || null,
    releaseUrl: release.htmlUrl || RELEASES_URL,
    releaseNotes: normalizeReleaseNotes(release.body),
    releaseNotesError: null,
    hasUpdate,
  };
}

async function fetchLatestRelease({ force = false } = {}) {
  const now = Date.now();
  const cacheTtl = Number.isFinite(RELEASE_CACHE_TTL_MS) ? Math.max(RELEASE_CACHE_TTL_MS, 60000) : 300000;

  if (!force && latestReleaseCache && now - latestReleaseFetchedAt < cacheTtl) {
    return latestReleaseCache;
  }

  if (latestReleaseRequest) return latestReleaseRequest;

  latestReleaseRequest = (async () => {
    const response = await fetch(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `${APP_NAME}-Updater`,
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub Release 请求失败：${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    const release = {
      tagName: String(payload.tag_name || ""),
      name: typeof payload.name === "string" ? payload.name : null,
      body: typeof payload.body === "string" ? payload.body : null,
      htmlUrl: typeof payload.html_url === "string" ? payload.html_url : null,
      publishedAt: typeof payload.published_at === "string" ? payload.published_at : null,
      createdAt: typeof payload.created_at === "string" ? payload.created_at : null,
    };

    if (!release.tagName) {
      throw new Error("GitHub Release 缺少版本标签");
    }

    latestReleaseCache = release;
    latestReleaseFetchedAt = Date.now();
    return release;
  })().finally(() => {
    latestReleaseRequest = null;
  });

  return latestReleaseRequest;
}

async function refreshLatestRelease(options) {
  try {
    const release = await fetchLatestRelease(options);
    const releaseStatus = createReleaseStatus(release);
    setStatus({
      latestVersion: releaseStatus.latestVersion,
      latestTag: releaseStatus.latestTag,
      releaseName: releaseStatus.releaseName,
      releaseDate: releaseStatus.releaseDate,
      releaseUrl: releaseStatus.releaseUrl,
      releaseNotes: releaseStatus.releaseNotes,
      releaseNotesError: null,
      updateAvailable: releaseStatus.hasUpdate,
    });
    return releaseStatus;
  } catch (error) {
    setStatus({
      releaseNotesError: errorMessage(error),
    });
    return null;
  }
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

  autoUpdater.on("update-available", (info) => {
    setStatus({
      ...updateStatusFromUpdaterInfo(info),
      phase: "update-available",
      updateAvailable: true,
      downloaded: false,
      message: `发现 ${normalizeTag(info?.version) || updateStatus.latestTag || "新版本"}`,
      error: null,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setStatus({
      phase: "up-to-date",
      updateAvailable: false,
      downloaded: false,
      message: "当前已是最新版本",
      error: null,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent);
    setStatus({
      phase: "downloading",
      message: `正在下载更新 (${percent}%)`,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus({
      ...updateStatusFromUpdaterInfo(info),
      phase: "downloaded",
      updateAvailable: true,
      downloaded: true,
      message: "新版本已下载完成",
      error: null,
    });
  });

  autoUpdater.on("error", (error) => {
    const wasChecking = updateStatus.phase === "checking";
    setStatus({
      phase: wasChecking ? "check-error" : "download-error",
      message: wasChecking ? "检查更新失败" : "下载更新失败",
      error: errorMessage(error),
    });
  });
}

function ensureConfigured() {
  if (configured) return true;
  if (!isSupportedPlatform()) {
    setStatus({
      phase: "unsupported",
      message: "当前平台不支持自动更新",
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

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.setFeedURL({
    provider: "github",
    owner: UPDATE_OWNER,
    repo: UPDATE_REPO,
  });

  bindAutoUpdaterEvents();
  configured = true;
  setStatus({ phase: "idle", message: "准备检查更新", error: null });
  return true;
}

async function checkForUpdates({ triggeredBy = "manual" } = {}) {
  setStatus({
    phase: "checking",
    updateAvailable: false,
    downloaded: false,
    message: "正在检查更新",
    error: null,
    releaseNotesError: null,
    triggeredBy,
  });

  const releaseStatus = await refreshLatestRelease({ force: true });

  if (!isSupportedPlatform()) {
    setStatus({
      phase: "unsupported",
      updateAvailable: Boolean(releaseStatus?.hasUpdate),
      message: releaseStatus?.hasUpdate
        ? `发现 ${releaseStatus.latestTag}，当前平台不支持自动更新`
        : "当前平台不支持自动更新",
      error: releaseStatus ? null : updateStatus.releaseNotesError,
      triggeredBy,
    });
    return cloneStatus();
  }

  if (!app.isPackaged && !ENABLE_DEV_UPDATES) {
    setStatus({
      phase: "disabled",
      updateAvailable: Boolean(releaseStatus?.hasUpdate),
      message: releaseStatus?.hasUpdate
        ? `发现 ${releaseStatus.latestTag}，开发环境请前往发布页下载`
        : "开发环境不会连接更新服务",
      error: releaseStatus ? null : updateStatus.releaseNotesError,
      triggeredBy,
    });
    return cloneStatus();
  }

  if (!ensureConfigured()) return cloneStatus();

  setStatus({ phase: "checking", message: "正在检查更新", triggeredBy });

  try {
    const result = await autoUpdater.checkForUpdates();

    if (!result) {
      setStatus({
        phase: "disabled",
        updateAvailable: false,
        downloaded: false,
        message: "自动更新不可用",
        error: null,
        triggeredBy,
      });
      return cloneStatus();
    }

    if (!result.isUpdateAvailable) {
      setStatus({
        phase: "up-to-date",
        updateAvailable: false,
        downloaded: false,
        message: "当前已是最新版本",
        error: null,
        triggeredBy,
      });
      return cloneStatus();
    }

    setStatus({
      ...updateStatusFromUpdaterInfo(result.updateInfo),
      phase: "update-available",
      updateAvailable: true,
      downloaded: false,
      message: `发现 ${normalizeTag(result.updateInfo?.version) || updateStatus.latestTag || "新版本"}`,
      error: null,
      triggeredBy,
    });
    return cloneStatus();
  } catch (error) {
    setStatus({
      phase: "check-error",
      updateAvailable: Boolean(releaseStatus?.hasUpdate),
      downloaded: false,
      message: "检查更新失败",
      error: errorMessage(error),
      triggeredBy,
    });
    return cloneStatus();
  }
}

async function downloadUpdate() {
  if (!updateStatus.updateAvailable) {
    throw new Error("没有可用的更新");
  }

  if (!isSupportedPlatform()) {
    throw new Error("当前平台不支持自动更新");
  }

  if (!app.isPackaged && !ENABLE_DEV_UPDATES) {
    throw new Error("开发环境不支持自动更新");
  }

  if (!ensureConfigured()) {
    throw new Error("自动更新未配置");
  }

  try {
    setStatus({
      phase: "downloading",
      message: updateStatus.latestTag
        ? `正在下载 ${updateStatus.latestTag}`
        : "正在下载更新",
      error: null,
    });
    await autoUpdater.downloadUpdate();
  } catch (error) {
    setStatus({
      phase: "download-error",
      message: "启动下载失败",
      error: errorMessage(error),
    });
    throw error;
  }

  return cloneStatus();
}

function initializeAutoUpdates() {
  if (autoCheckTimer) return cloneStatus();

  const delayMs = Number.isFinite(AUTO_CHECK_DELAY_MS) ? Math.max(AUTO_CHECK_DELAY_MS, 0) : 3000;
  const intervalMs = Number.isFinite(AUTO_CHECK_INTERVAL_MS)
    ? Math.max(AUTO_CHECK_INTERVAL_MS, 60000)
    : 21600000;

  setTimeout(() => {
    void checkForUpdates({ triggeredBy: "auto" });
    autoCheckTimer = setInterval(() => void checkForUpdates({ triggeredBy: "auto" }), intervalMs);
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
  ipcMain.handle("updates:check", () => checkForUpdates({ triggeredBy: "manual" }));
  ipcMain.handle("updates:download", () => downloadUpdate());
  ipcMain.handle("updates:install", () => installUpdate());
  ipcMain.handle("updates:open-releases", async () => shell.openExternal(RELEASES_URL));
}

module.exports = {
  initializeAutoUpdates,
  register,
};
