// 应用路径与数据目录管理
// 集中处理 userData 目录、内置资源同步、数据目录初始化。
import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { ensureDir, copyDirContents } from "./fs-utils.js";
import { pMap, LOCAL_IO_CONCURRENCY } from "./concurrency.js";

// userData 根目录
function dataDir() {
  return app.getPath("userData");
}

// 在多个候选位置中找到第一个真实存在的资源路径
function projectResourcePath(...segments: string[]) {
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

// 把内置资源（skills/mcp）同步到 userData
async function mirrorBuiltinResource(source: string, target: string) {
  if (!fs.existsSync(source)) return;

  const baseDir = path.resolve(dataDir());
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== baseDir && !resolvedTarget.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(`Refusing to replace directory outside userData: ${resolvedTarget}`);
  }

  await fsp.rm(resolvedTarget, { recursive: true, force: true });
  await copyDirContents(source, resolvedTarget, true);
}

async function syncBuiltinResources() {
  const root = projectResourcePath("resources");
  if (!root) return;
  const dir = dataDir();
  await mirrorBuiltinResource(path.join(root, "builtin", "skills"), path.join(dir, "skills", "builtin")).catch((error) => {
    console.warn("同步内置 Skills 失败:", error);
  });
  await mirrorBuiltinResource(path.join(root, "builtin", "mcp"), path.join(dir, "mcp", "builtin")).catch((error) => {
    console.warn("同步内置 MCP 失败:", error);
  });
}

// AGENTS.md 默认内容：安装时写入，用户可在设置中编辑
const DEFAULT_AGENTS_MD = `# PolarAgent

你是 PolarAgent——用户的执行型协作伙伴，直接帮对方把事情做成。

## 核心原则

- **工具优先**：能直接完成的操作就不要只给建议。优先使用已启用的工具完成实际操作。
- **透明推理**：关键决策前说明原因，让用户理解思路并有机会介入。
- **权限确认**：涉及文件删除、大量修改、危险命令时，先说明影响范围并请求确认。
- **任务分解**：复杂任务自动拆解为可执行步骤，用待办清单追踪进度。

## 工作流程

1. **理解目标**：需求模糊时用具体问题澄清，不凭空假设。
2. **方案设计**：列出执行计划，标注需要确认的操作。
3. **执行+追踪**：逐步执行并更新进度，让用户随时知道做到哪一步。
4. **交付成果**：确保交付可直接使用的成果，避免半成品。

## 沟通风格

- 默认使用中文，简洁、务实、口语化。
- 给出结论时说清依据；不确定就明说，并提出验证方式。
- 对用户提供的信息保持尊重。
`;

// 确保数据目录及全部子目录存在，并同步内置资源
async function ensureDataDir() {
  const subdirs = [
    "config",
    "skills/builtin",
    "skills/custom",
    "mcp/builtin",
    "mcp/packages/npm-cache",
    "conversations",
    "knowledge",
    "memory/project-context",
    "memory/user-preferences",
    "logs",
  ];
  await ensureDir(dataDir());
  await pMap(
    subdirs,
    (subdir: string) => ensureDir(path.join(dataDir(), subdir)),
    LOCAL_IO_CONCURRENCY,
  );
  // 首启时创建默认 AGENTS.md（已存在则不覆盖）
  const agentsMd = path.join(dataDir(), "AGENTS.md");
  if (!fs.existsSync(agentsMd)) {
    await fsp.writeFile(agentsMd, DEFAULT_AGENTS_MD, "utf-8").catch(() => {});
  }
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

export {
  dataDir,
  projectResourcePath,
  appIconPath,
  syncBuiltinResources,
  ensureDataDir,
  readSettingCloseToTray,
  readSettingStartInSystemTray,
};
