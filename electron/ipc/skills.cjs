// IPC：技能（Skill）列举、元数据读取、从 Git/本地/压缩包安装、写入和删除
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { dataDir } = require("../lib/app-paths.cjs");
const { ensureDir, readText } = require("../lib/fs-utils.cjs");

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

// 列举 builtin/custom 下的 Agent Skill 目录
async function listSkills(skillType) {
  const dir = path.join(dataDir(), "skills", skillType === "builtin" ? "builtin" : "custom");
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
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

// ==================== Write / Patch / Delete Skill Helpers ====================

/** 校验技能名称格式：只能包含小写字母、数字和连字符 */
function validateSkillName(name) {
  if (!name || typeof name !== "string") {
    throw new Error("技能名称不能为空");
  }
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("技能名称不能为空");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new Error(`技能名称「${trimmed}」格式无效。只能包含小写字母、数字和连字符。`);
  }
  return trimmed;
}

/** 获取技能在 custom 目录下的真实路径，并校验路径安全 */
function getCustomSkillDir(name) {
  const customDir = path.join(dataDir(), "skills", "custom");
  const skillDir = path.join(customDir, name);
  // 校验路径不越界
  const resolved = path.resolve(skillDir);
  const allowedPrefix = path.resolve(customDir);
  if (!resolved.startsWith(allowedPrefix + path.sep) && resolved !== allowedPrefix) {
    throw new Error("技能路径超出允许范围");
  }
  return { skillDir: resolved, customDir: allowedPrefix };
}

/** 创建备份（保留最多 10 个版本） */
async function backupSkillMd(skillMdPath) {
  if (!fs.existsSync(skillMdPath)) return;
  const dir = path.dirname(skillMdPath);
  const bakDir = path.join(dir, ".bak");
  await ensureDir(bakDir);

  // 读取现有备份并按顺序整理
  const entries = await fsp.readdir(bakDir).catch(() => []);
  const bakFiles = entries
    .filter((e) => e.startsWith("SKILL.md.") && e.endsWith(".bak"))
    .sort((a, b) => {
      const numA = parseInt(a.replace("SKILL.md.", "").replace(".bak", ""), 10);
      const numB = parseInt(b.replace("SKILL.md.", "").replace(".bak", ""), 10);
      return numA - numB;
    });

  // 保留最多 10 个版本，超出则删除最旧的
  while (bakFiles.length >= 10) {
    const oldest = bakFiles.shift();
    await fsp.unlink(path.join(bakDir, oldest)).catch(() => {});
  }

  // 新备份编号为当前最大编号 +1
  const maxNum = bakFiles.length > 0
    ? parseInt(bakFiles[bakFiles.length - 1].replace("SKILL.md.", "").replace(".bak", ""), 10)
    : 0;
  const newBakPath = path.join(bakDir, `SKILL.md.${maxNum + 1}.bak`);
  await fsp.copyFile(skillMdPath, newBakPath);
}

function validateSkillContent(content, expectedName) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("SKILL.md 内容不能为空");
  }
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) {
    throw new Error("SKILL.md 缺少 frontmatter（--- 包裹的 name/description 段）");
  }
  const frontmatter = match[1];
  const name = frontmatter.match(/^name:\s*(.+)$/m)?.[1]?.trim()?.replace(/^['\"]|['\"]$/g, "");
  const description = frontmatter.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  if (!name) {
    throw new Error("SKILL.md frontmatter 缺少 name 字段");
  }
  if (name !== expectedName) {
    throw new Error(`SKILL.md 中的 name 必须与技能目录名一致（期望 ${expectedName}，实际 ${name}）`);
  }
  if (!description) {
    throw new Error("SKILL.md frontmatter 缺少 description 字段");
  }
}

async function writeTextAtomically(targetPath, content, previousContent) {
  const tempPath = `${targetPath}.tmp-${Date.now()}`;
  try {
    await fsp.writeFile(tempPath, content, "utf8");
    if (fs.existsSync(targetPath)) {
      await fsp.rm(targetPath, { force: true });
    }
    await fsp.rename(tempPath, targetPath);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    if (typeof previousContent === "string") {
      await fsp.writeFile(targetPath, previousContent, "utf8").catch(() => {});
    }
    throw error;
  }
}

async function backupSkillDirForDeletion(skillDir, name, customDir) {
  const deletedRoot = path.join(customDir, ".deleted");
  await ensureDir(deletedRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(deletedRoot, `${name}-${timestamp}`);
  await copySkill(skillDir, backupDir);
  return backupDir;
}

/** 创建或编辑技能（全量写入 SKILL.md） */
async function writeSkill(name, content) {
  const validatedName = validateSkillName(name);
  const { skillDir } = getCustomSkillDir(validatedName);
  const skillMdPath = path.join(skillDir, "SKILL.md");
  const existed = fs.existsSync(skillMdPath);
  const previousContent = existed ? await readText(skillMdPath) : undefined;

  validateSkillContent(content, validatedName);

  // 确保目录存在
  await ensureDir(skillDir);

  // 如果文件已存在，先备份
  if (existed) {
    await backupSkillMd(skillMdPath);
  }

  // 写入 SKILL.md
  await writeTextAtomically(skillMdPath, content, previousContent);

  return {
    success: true,
    path: skillMdPath,
    message: existed ? "技能已更新" : "技能已创建",
  };
}

/** 精确替换技能内容 */
async function patchSkill(name, oldString, newString) {
  const validatedName = validateSkillName(name);
  const { skillDir } = getCustomSkillDir(validatedName);
  const skillMdPath = path.join(skillDir, "SKILL.md");

  if (!fs.existsSync(skillMdPath)) {
    throw new Error(`技能「${validatedName}」不存在，无法 patch`);
  }

  // 读取原内容
  const original = await readText(skillMdPath);

  // 校验 oldString
  if (!original.includes(oldString)) {
    throw new Error("未在 SKILL.md 中找到 old_string，请确认片段是否逐字符精确匹配");
  }

  // 统计出现次数
  let count = 0;
  let from = 0;
  while (true) {
    const index = original.indexOf(oldString, from);
    if (index === -1) break;
    count += 1;
    from = index + oldString.length;
  }

  if (count > 1) {
    throw new Error(`old_string 在文件中出现 ${count} 次，存在歧义。请提供更长的唯一片段。`);
  }

  // 备份并替换
  await backupSkillMd(skillMdPath);
  const updated = original.replace(oldString, newString);
  validateSkillContent(updated, validatedName);
  await writeTextAtomically(skillMdPath, updated, original);

  return {
    success: true,
    path: skillMdPath,
    message: "SKILL.md 已精确替换",
  };
}

/** 删除技能 */
async function deleteSkill(name) {
  const validatedName = validateSkillName(name);
  const { skillDir } = getCustomSkillDir(validatedName);

  if (!fs.existsSync(skillDir)) {
    throw new Error(`技能「${validatedName}」不存在`);
  }

  // 确认是 custom 目录下的技能（不能删 builtin）
  const customDir = path.join(dataDir(), "skills", "custom");
  const resolvedSkillDir = path.resolve(skillDir);
  const resolvedCustomDir = path.resolve(customDir);
  if (!resolvedSkillDir.startsWith(resolvedCustomDir + path.sep)) {
    throw new Error("只能删除 custom 目录下的技能");
  }

  const backupDir = await backupSkillDirForDeletion(skillDir, validatedName, resolvedCustomDir);
  await fsp.rm(skillDir, { recursive: true, force: true });

  return {
    success: true,
    path: skillDir,
    message: `技能「${validatedName}」已删除（备份: ${backupDir}）`,
  };
}

// ==================== IPC Handlers ====================

function register(ipcMain) {
  ipcMain.handle("skills:list", (_event, { skillType }) => listSkills(skillType));
  ipcMain.handle("skills:read-metadata", (_event, { skillId }) => readSkillMetadata(skillId));
  ipcMain.handle("skills:install-git", (_event, { repoUrl }) => installSkillFromGit(repoUrl));
  ipcMain.handle("skills:install-local", (_event, { sourcePath }) => installSkillFromLocal(sourcePath));
  ipcMain.handle("skills:install-zip", (_event, { zipPath }) => installSkillFromZip(zipPath));
  ipcMain.handle("skills:uninstall", (_event, { skillId }) => uninstallSkill(skillId));
  // 写入技能（创建或全量编辑）
  ipcMain.handle("skills:write-skill", (_event, { name, content }) => writeSkill(name, content));
  // 精确替换技能内容
  ipcMain.handle("skills:patch-skill", (_event, { name, oldString, newString }) => patchSkill(name, oldString, newString));
  // 删除技能
  ipcMain.handle("skills:delete-skill", (_event, { name }) => deleteSkill(name));
}

module.exports = { register };
