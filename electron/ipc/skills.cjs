// IPC：技能（Skill）列举、元数据读取、从 Git/本地/压缩包安装
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { dataDir } = require("../lib/app-paths.cjs");
const { ensureDir, readText, listJsonIds } = require("../lib/fs-utils.cjs");

// 检查是否安装了 jszip 模块
let JSZip;
try {
  JSZip = require("jszip");
} catch (error) {
  console.warn("jszip 模块未安装，压缩包安装功能将不可用");
}

// 是否受支持的 Git URL
function supportedGitUrl(input) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(input);
}

// 将任意名称规整为安全 slug
function sanitizeSlug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

// 在父目录下生成不冲突的子目录路径
function uniqueChild(parent, slug) {
  let candidate = path.join(parent, slug);
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = path.join(parent, `${slug}-${suffix++}`);
  return candidate;
}

// 解析 GitHub URL 为 clone 信息（含分支与子目录）
function parseGithubSource(input) {
  const cleaned = input.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  const match = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?$/);
  if (!match) return null;
  return {
    cloneUrl: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}.git`,
    branch: match[4],
    subdir: match[5],
  };
}

// 通用 Git 源解析（GitHub 优先，否则原样作为 clone URL）
function gitSource(input) {
  const github = parseGithubSource(input);
  if (github) return github;
  return { cloneUrl: input, branch: undefined, subdir: undefined };
}

// 运行子进程并收集 stdout/stderr
async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

// 递归收集包含 SKILL.md 的目录（限定深度）
async function collectSkillRoots(root, depth = 0, matches = []) {
  if (depth > 4 || !fs.existsSync(root)) return matches;
  if (fs.existsSync(path.join(root, "SKILL.md"))) {
    matches.push(root);
    return matches;
  }
  const skillsDir = path.join(root, "skills");
  const scanRoot = depth === 0 && fs.existsSync(skillsDir) ? skillsDir : root;
  const entries = await fsp.readdir(scanRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || [".git", "node_modules"].includes(entry.name)) continue;
    await collectSkillRoots(path.join(scanRoot, entry.name), depth + 1, matches);
  }
  return matches;
}

// 在源目录中定位唯一可安装的 Skill 根目录
async function installableSkillRoot(root) {
  const matches = await collectSkillRoots(root);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error("未找到 SKILL.md，无法安装为 Skill");
  throw new Error("该目录包含多个 SKILL.md，请安装单个 Skill 目录");
}

// 复制 Skill 目录（跳过 .git）
async function copySkill(source, target) {
  await ensureDir(target);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copySkill(sourcePath, targetPath);
    else {
      await ensureDir(path.dirname(targetPath));
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

// 从 Git 仓库安装 Skill（浅克隆到临时目录后复制）
async function installSkillFromGit(repoUrl) {
  const trimmed = String(repoUrl || "").trim();
  if (!trimmed) throw new Error("缺少 Git 仓库 URL");
  if (!supportedGitUrl(trimmed)) throw new Error("仅支持 http(s)、ssh 或 git 协议的 Git 仓库 URL");
  const customDir = path.join(dataDir(), "skills", "custom");
  const tmpRoot = path.join(dataDir(), "skills", ".tmp-install");
  await ensureDir(customDir);
  await ensureDir(tmpRoot);
  const source = gitSource(trimmed);
  const baseSlug = sanitizeSlug(source.subdir ? path.basename(source.subdir) : path.basename(source.cloneUrl, ".git"));
  const tempDir = uniqueChild(tmpRoot, baseSlug);
  const cloneDir = path.join(tempDir, "repo");
  await ensureDir(tempDir);
  try {
    const args = ["clone", "--depth", "1"];
    if (source.branch) args.push("--branch", source.branch);
    args.push("--", source.cloneUrl, cloneDir);
    await runProcess("git", args);
    const searchRoot = source.subdir ? path.join(cloneDir, source.subdir) : cloneDir;
    const skillRoot = await installableSkillRoot(searchRoot);
    const target = uniqueChild(customDir, sanitizeSlug(path.basename(skillRoot) || baseSlug));
    await copySkill(skillRoot, target);
    return target;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 从本地目录安装 Skill
async function installSkillFromLocal(sourcePath) {
  const source = String(sourcePath || "").trim();
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("本地 Skill 源目录不存在");
  const skillRoot = await installableSkillRoot(source);
  const customDir = path.join(dataDir(), "skills", "custom");
  await ensureDir(customDir);
  const target = uniqueChild(customDir, sanitizeSlug(path.basename(skillRoot) || "skill"));
  await copySkill(skillRoot, target);
  return target;
}

// 从压缩包安装 Skill（解压到临时目录后复制）
async function installSkillFromZip(zipPath) {
  if (!JSZip) throw new Error("jszip 模块未安装，无法解压缩包");
  const source = String(zipPath || "").trim();
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error("压缩包文件不存在");
  if (!source.toLowerCase().endsWith(".zip")) throw new Error("仅支持 .zip 格式的压缩包");

  const customDir = path.join(dataDir(), "skills", "custom");
  const tmpRoot = path.join(dataDir(), "skills", ".tmp-install");
  await ensureDir(customDir);
  await ensureDir(tmpRoot);

  const baseSlug = sanitizeSlug(path.basename(source, ".zip"));
  const tempDir = uniqueChild(tmpRoot, baseSlug);
  await ensureDir(tempDir);

  try {
    // 读取压缩包
    const zipData = await fsp.readFile(source);
    const zip = await JSZip.loadAsync(zipData);

    // 解压所有文件到临时目录
    const extractPromises = [];
    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) return;
      const targetPath = path.join(tempDir, relativePath);
      extractPromises.push(
        zipEntry.async("nodebuffer").then(async (content) => {
          await ensureDir(path.dirname(targetPath));
          await fsp.writeFile(targetPath, content);
        })
      );
    });
    await Promise.all(extractPromises);

    // 查找技能根目录
    const skillRoot = await installableSkillRoot(tempDir);
    const target = uniqueChild(customDir, sanitizeSlug(path.basename(skillRoot) || baseSlug));
    await copySkill(skillRoot, target);
    return target;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

// 列举 builtin/custom 下的 Skill（优先按 JSON id，回退按子目录名）
async function listSkills(skillType) {
  const dir = path.join(dataDir(), "skills", skillType === "builtin" ? "builtin" : "custom");
  return listJsonIds(dir).catch(async () => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  });
}

// 读取指定 Skill 的 SKILL.md 元数据
async function readSkillMetadata(skillId) {
  for (const type of ["custom", "builtin"]) {
    const file = path.join(dataDir(), "skills", type, skillId, "SKILL.md");
    if (fs.existsSync(file)) return readText(file);
  }
  throw new Error(`Skill not found: ${skillId}`);
}

// 删除指定的 Skill（仅支持 custom 类型）
async function uninstallSkill(skillId) {
  const customDir = path.join(dataDir(), "skills", "custom", skillId);
  const builtinDir = path.join(dataDir(), "skills", "builtin", skillId);

  // 检查是否是内置技能
  if (fs.existsSync(builtinDir)) {
    throw new Error("无法删除内置技能");
  }

  // 检查自定义技能是否存在
  if (!fs.existsSync(customDir)) {
    throw new Error(`技能不存在: ${skillId}`);
  }

  // 删除技能目录
  await fsp.rm(customDir, { recursive: true, force: true });
  console.log(`技能已删除: ${skillId}`);
  return true;
}

function register(ipcMain) {
  ipcMain.handle("skills:list", (_event, { skillType }) => listSkills(skillType));
  ipcMain.handle("skills:read-metadata", (_event, { skillId }) => readSkillMetadata(skillId));
  ipcMain.handle("skills:install-git", (_event, { repoUrl }) => installSkillFromGit(repoUrl));
  ipcMain.handle("skills:install-local", (_event, { sourcePath }) => installSkillFromLocal(sourcePath));
  ipcMain.handle("skills:install-zip", (_event, { zipPath }) => installSkillFromZip(zipPath));
  ipcMain.handle("skills:uninstall", (_event, { skillId }) => uninstallSkill(skillId));
}

module.exports = { register };
