// IPC：文件系统读写、目录列举、stat、临时文件
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ensureDir, readText } = require("../lib/fs-utils.cjs");
const { validateFileAccess, setSecurityMode } = require("../lib/security.cjs");

function register(ipcMain) {
  // 读取文件（所有安全模式都允许）
  ipcMain.handle("fs:read-file", (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    return readText(target);
  });
  
  ipcMain.handle("fs:read-base64-file", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const buffer = await fsp.readFile(target);
    return buffer.toString("base64");
  });
  
  // 读取二进制文件，返回 base64 编码（渲染层再 atob 转 Uint8Array）
  ipcMain.handle("fs:read-binary-file", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const buffer = await fsp.readFile(target);
    return buffer.toString("base64");
  });
  
  // 写入文件（需要权限校验）
  ipcMain.handle("fs:write-file", async (_event, { path: target, content }) => {
    const validation = validateFileAccess(target, "write");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, content, "utf8");
  });
  
  ipcMain.handle("fs:write-base64-file", async (_event, { path: target, content }) => {
    const validation = validateFileAccess(target, "write");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, Buffer.from(String(content || ""), "base64"));
  });
  
  ipcMain.handle("fs:append-file", async (_event, { path: target, content }) => {
    const validation = validateFileAccess(target, "write");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    await ensureDir(path.dirname(target));
    await fsp.appendFile(target, content, "utf8");
  });
  
  ipcMain.handle("fs:create-directory", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "write");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    return ensureDir(target);
  });
  
  // 删除路径（需要权限校验）
  ipcMain.handle("fs:delete-path", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "delete");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const stat = await fsp.stat(target);
    await fsp.rm(target, { recursive: stat.isDirectory(), force: true });
  });

  // 重命名/移动路径（源路径需要删除权限，目标路径需要写入权限）
  ipcMain.handle("fs:rename", async (_event, { src, dest }) => {
    const srcValidation = validateFileAccess(src, "delete");
    if (!srcValidation.allowed) {
      throw new Error(srcValidation.reason);
    }
    const destValidation = validateFileAccess(dest, "write");
    if (!destValidation.allowed) {
      throw new Error(destValidation.reason);
    }
    await ensureDir(path.dirname(dest));
    try {
      await fsp.rename(src, dest);
    } catch (err) {
      // 跨分区/设备移动时回退为复制后删除
      if (err && err.code === "EXDEV") {
        await fsp.cp(src, dest, { recursive: true, force: true });
        const stat = await fsp.stat(src);
        await fsp.rm(src, { recursive: stat.isDirectory(), force: true });
      } else {
        throw err;
      }
    }
  });

  // 复制路径（源路径需要读取权限，目标路径需要写入权限）
  ipcMain.handle("fs:copy", async (_event, { src, dest }) => {
    const srcValidation = validateFileAccess(src, "read");
    if (!srcValidation.allowed) {
      throw new Error(srcValidation.reason);
    }
    const destValidation = validateFileAccess(dest, "write");
    if (!destValidation.allowed) {
      throw new Error(destValidation.reason);
    }
    await ensureDir(path.dirname(dest));
    await fsp.cp(src, dest, { recursive: true, force: true });
  });

  // 列举目录（读取操作）
  ipcMain.handle("fs:list-directory", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  });
  
  ipcMain.handle("fs:list-directory-entries", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  });
  
  // 检查文件存在性（读取操作）
  ipcMain.handle("fs:exists", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    return fs.existsSync(target);
  });
  
  // 获取文件信息（读取操作）
  ipcMain.handle("fs:stat", async (_event, { path: target }) => {
    const validation = validateFileAccess(target, "read");
    if (!validation.allowed) {
      throw new Error(validation.reason);
    }
    const stat = await fsp.stat(target);
    return { 
      isDirectory: stat.isDirectory(), 
      isFile: stat.isFile(), 
      isSymlink: stat.isSymbolicLink(), 
      size: stat.size, 
      mtimeMs: stat.mtimeMs 
    };
  });
  
  // 创建临时目录，返回绝对路径（临时目录始终允许）
  ipcMain.handle("fs:create-temp-dir", async (_event, { prefix }) => {
    const tmpBase = os.tmpdir();
    const dir = await fsp.mkdtemp(path.join(tmpBase, prefix || "polaragent-"));
    return dir;
  });
  
  // 创建临时文件，返回绝对路径（临时文件始终允许）
  ipcMain.handle("fs:create-temp-file", async (_event, { prefix, suffix }) => {
    const tmpBase = os.tmpdir();
    const fileName = `${prefix || ""}${Date.now()}-${Math.random().toString(36).slice(2)}${suffix || ""}`;
    const filePath = path.join(tmpBase, fileName);
    await fsp.writeFile(filePath, "", "utf8");
    return filePath;
  });

  // 安全模式同步：渲染进程切换权限模式时同步到主进程
  ipcMain.handle("security:set-mode", (_event, { mode }) => {
    setSecurityMode(mode);
  });
}

module.exports = { register };
