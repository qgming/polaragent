// IPC：文件系统读写、目录列举、stat、临时文件
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { ensureDir, readText } = require("../lib/fs-utils.cjs");

function register(ipcMain) {
  ipcMain.handle("fs:read-file", (_event, { path: target }) => readText(target));
  ipcMain.handle("fs:read-base64-file", async (_event, { path: target }) => {
    const buffer = await fsp.readFile(target);
    return buffer.toString("base64");
  });
  // 读取二进制文件，返回 base64 编码（渲染层再 atob 转 Uint8Array）
  ipcMain.handle("fs:read-binary-file", async (_event, { path: target }) => {
    const buffer = await fsp.readFile(target);
    return buffer.toString("base64");
  });
  ipcMain.handle("fs:write-file", async (_event, { path: target, content }) => {
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, content, "utf8");
  });
  ipcMain.handle("fs:write-base64-file", async (_event, { path: target, content }) => {
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, Buffer.from(String(content || ""), "base64"));
  });
  ipcMain.handle("fs:append-file", async (_event, { path: target, content }) => {
    await ensureDir(path.dirname(target));
    await fsp.appendFile(target, content, "utf8");
  });
  ipcMain.handle("fs:create-directory", (_event, { path: target }) => ensureDir(target));
  ipcMain.handle("fs:delete-path", async (_event, { path: target }) => {
    const stat = await fsp.stat(target);
    await fsp.rm(target, { recursive: stat.isDirectory(), force: true });
  });
  ipcMain.handle("fs:list-directory", async (_event, { path: target }) => {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  });
  ipcMain.handle("fs:list-directory-entries", async (_event, { path: target }) => {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  });
  ipcMain.handle("fs:exists", async (_event, { path: target }) => fs.existsSync(target));
  ipcMain.handle("fs:stat", async (_event, { path: target }) => {
    const stat = await fsp.stat(target);
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), isSymlink: stat.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs };
  });
  // 创建临时目录，返回绝对路径
  ipcMain.handle("fs:create-temp-dir", async (_event, { prefix }) => {
    const tmpBase = os.tmpdir();
    const dir = await fsp.mkdtemp(path.join(tmpBase, prefix || "polaragent-"));
    return dir;
  });
  // 创建临时文件，返回绝对路径
  ipcMain.handle("fs:create-temp-file", async (_event, { prefix, suffix }) => {
    const tmpBase = os.tmpdir();
    const fileName = `${prefix || ""}${Date.now()}-${Math.random().toString(36).slice(2)}${suffix || ""}`;
    const filePath = path.join(tmpBase, fileName);
    await fsp.writeFile(filePath, "", "utf8");
    return filePath;
  });
}

module.exports = { register };
