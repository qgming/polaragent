// 通用文件系统工具
// 这些函数无 Electron 依赖，供主进程各 ipc 模块复用。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// 递归创建目录
async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

// 读取 UTF-8 文本
async function readText(file) {
  return fsp.readFile(file, "utf8");
}

// 原子写 JSON 文件（先写临时文件再 rename，写入前校验 JSON 合法）
// 每次调用使用唯一的临时文件名，避免并发写入时两个操作共用同一个 .tmp 路径导致竞态
async function writeJsonFile(file, content) {
  JSON.parse(content);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fsp.writeFile(tmp, content, "utf8");
    await fsp.rename(tmp, file);
  } catch (error) {
    // 清理可能残留的临时文件
    try { await fsp.unlink(tmp); } catch { /* 忽略 */ }
    throw error;
  }
}

// 递归复制目录内容；overwriteExisting=false 时跳过已存在文件
async function copyDirContents(source, target, overwriteExisting = true) {
  await ensureDir(target);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(sourcePath, targetPath, overwriteExisting);
      continue;
    }
    if (!overwriteExisting && fs.existsSync(targetPath)) continue;
    await ensureDir(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  }
}

// 列举目录（或其多个子目录）下的全部 JSON id（去重排序），供 config / skills 复用
async function listJsonIds(dir, subdirs) {
  if (!fs.existsSync(dir)) return [];
  const ids = new Set();
  const dirs = subdirs ? subdirs.map((subdir) => path.join(dir, subdir)) : [dir];
  for (const targetDir of dirs) {
    if (!fs.existsSync(targetDir)) continue;
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && path.extname(entry.name) === ".json") {
        ids.add(path.basename(entry.name, ".json"));
      }
    }
  }
  return Array.from(ids).sort();
}

module.exports = {
  ensureDir,
  readText,
  writeJsonFile,
  copyDirContents,
  listJsonIds,
};
