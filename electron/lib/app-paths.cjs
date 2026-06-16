// 应用路径与数据目录管理
// 集中处理 userData 目录、内置资源同步、数据目录初始化。
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const { ensureDir, copyDirContents } = require("./fs-utils.cjs");
const { pMap, LOCAL_IO_CONCURRENCY } = require("./concurrency.cjs");

// userData 根目录
function dataDir() {
  return app.getPath("userData");
}

// 在多个候选位置中找到第一个真实存在的资源路径
function projectResourcePath(...segments) {
  const candidates = [
    path.join(process.resourcesPath || "", ...segments),
    path.join(app.getAppPath(), ...segments),
    path.join(process.cwd(), ...segments),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

// 应用图标路径（按优先级回退）
function appIconPath() {
  return (
    projectResourcePath("build", "icon.ico") ||
    projectResourcePath("build", "icon.png") ||
    projectResourcePath("dist", "logo.png") ||
    projectResourcePath("public", "logo.png")
  );
}

// 把内置资源（skills/agents/mcp）同步到 userData
async function syncBuiltinResources() {
  const root = projectResourcePath("resources");
  if (!root) return;
  const dir = dataDir();
  await copyDirContents(path.join(root, "builtin", "skills"), path.join(dir, "skills", "builtin"), true).catch(() => {});
  await copyDirContents(path.join(root, "builtin", "agents"), path.join(dir, "agents", "builtin"), false).catch(() => {});
  await copyDirContents(path.join(root, "builtin", "mcp"), path.join(dir, "mcp", "builtin"), true).catch(() => {});
}

// 确保数据目录及全部子目录存在，并同步内置资源
async function ensureDataDir() {
  const subdirs = [
    "config",
    "agents/builtin",
    "agents/custom",
    "skills/builtin",
    "skills/custom",
    "mcp/builtin",
    "mcp/packages/npm-cache",
    "conversations",
    "teams",
    "teams/conversations",
    "knowledge",
    "memory/project-context",
    "memory/user-preferences",
    "logs",
  ];
  await ensureDir(dataDir());
  await pMap(
    subdirs,
    (subdir) => ensureDir(path.join(dataDir(), subdir)),
    LOCAL_IO_CONCURRENCY,
  );
  await syncBuiltinResources();
}

// 同步读取 window.closeToTray 配置（默认 true，关闭到托盘保留后台运行）
function readSettingCloseToTray() {
  try {
    const p = path.join(dataDir(), "config", "settings.json");
    if (!fs.existsSync(p)) return true;
    return JSON.parse(fs.readFileSync(p, "utf-8"))?.window?.closeToTray ?? true;
  } catch { return true; }
}

// 同步读取 window.startInSystemTray 配置（默认 false，正常启动显示窗口）
function readSettingStartInSystemTray() {
  try {
    const p = path.join(dataDir(), "config", "settings.json");
    if (!fs.existsSync(p)) return false;
    return JSON.parse(fs.readFileSync(p, "utf-8"))?.window?.startInSystemTray ?? false;
  } catch { return false; }
}

module.exports = {
  dataDir,
  projectResourcePath,
  appIconPath,
  syncBuiltinResources,
  ensureDataDir,
  readSettingCloseToTray,
  readSettingStartInSystemTray,
};
