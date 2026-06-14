// IPC：应用、窗口、对话框、文件预览窗口
const { BrowserWindow, dialog, shell, app } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { APP_NAME } = require("../lib/constants.cjs");
const { dataDir, ensureDataDir } = require("../lib/app-paths.cjs");
const { ensureDir } = require("../lib/fs-utils.cjs");
const { getMainWindow, createWindow, loadApp } = require("../lib/windows.cjs");

const DOCUMENT_EXTENSIONS = [
  "txt", "md", "markdown", "mdx", "json", "csv", "log", "xml", "yaml", "yml",
  "pdf", "docx", "toml", "ini", "html", "htm", "css", "scss", "less", "ts",
  "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "sh", "rb",
  "php", "sql", "env",
];

// 已打开的预览窗口：key -> BrowserWindow
const previewWindows = new Map();

// 由文件路径派生稳定的预览窗口 key（同一文件复用同一窗口）
function labelForPath(filePath) {
  let hash = 5381;
  for (let index = 0; index < filePath.length; index += 1) {
    hash = (hash * 33) ^ filePath.charCodeAt(index);
  }
  return `preview-${(hash >>> 0).toString(36)}`;
}

function register(ipcMain) {
  ipcMain.handle("app:get-data-dir", () => dataDir());
  ipcMain.handle("app:get-home-dir", () => app.getPath("home"));
  ipcMain.handle("app:ensure-data-dir", ensureDataDir);
  ipcMain.handle("app:open-data-dir", async () => {
    await ensureDir(dataDir());
    await shell.openPath(dataDir());
  });
  ipcMain.handle("app:open-path", async (_event, { path: target }) => shell.openPath(target));
  ipcMain.handle("app:open-external", async (_event, { url }) => shell.openExternal(url));
  ipcMain.handle("app:file-url", (_event, { path: target }) => pathToFileURL(target).toString());
  ipcMain.handle("dialog:pick-directory", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-text-file", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openFile"],
      filters: [
        {
          name: "文档文件",
          extensions: DOCUMENT_EXTENSIONS,
        },
      ],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-multiple-files", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "文档文件",
          extensions: DOCUMENT_EXTENSIONS,
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("dialog:pick-image-file", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openFile"],
      filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-audio-file", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openFile"],
      filters: [{ name: "音频文件", extensions: ["mp3", "wav", "m4a", "aac", "ogg", "flac", "webm", "opus"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-document-file", async () => {
    const result = await dialog.showOpenDialog(getMainWindow(), {
      properties: ["openFile"],
      filters: [{ name: "文档文件", extensions: ["pdf", "docx"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("window:set-title", (event, { title }) => BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title || APP_NAME)));
  ipcMain.handle("window:is-maximized", (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false);
  ipcMain.handle("preview:open", async (_event, { path: filePath }) => {
    if (!filePath) return;

    if (/^https?:\/\//i.test(filePath)) {
      await shell.openExternal(filePath);
      return;
    }

    const key = labelForPath(filePath);
    const existing = previewWindows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const win = createWindow({
      width: 800,     // 默认宽度：900 → 800 (预览窗口更紧凑)
      height: 660,    // 默认高度：720 → 660 (保持比例)
      minWidth: 480,  // 最小宽度：保持 480 (已经很合理)
      minHeight: 360, // 最小高度：保持 360 (已经很合理)
      title: path.basename(filePath),
      parent: getMainWindow(),
    });
    previewWindows.set(key, win);
    win.on("closed", () => previewWindows.delete(key));
    loadApp(win, `?view=preview&path=${encodeURIComponent(filePath)}`);
  });
}

module.exports = { register };
