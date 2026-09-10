// IPC：应用、窗口、对话框
import { BrowserWindow, dialog, shell, app, type IpcMain, type IpcMainInvokeEvent } from "electron";
import { pathToFileURL } from "node:url";

import { APP_NAME } from "../lib/constants.js";
import { dataDir, ensureDataDir } from "../lib/app-paths.js";
import { ensureDir } from "../lib/fs-utils.js";
import { isSafeExternalUrl } from "../lib/session-security.js";
import { getMainWindow } from "../lib/windows.js";

const DOCUMENT_EXTENSIONS = [
  "txt", "md", "markdown", "mdx", "json", "csv", "log", "xml", "yaml", "yml",
  "toml", "ini", "html", "htm", "css", "scss", "less", "ts",
  "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "sh", "rb",
  "php", "sql", "env",
];

function register(ipcMain: IpcMain) {
  ipcMain.handle("app:get-data-dir", () => dataDir());
  ipcMain.handle("app:get-home-dir", () => app.getPath("home"));
  ipcMain.handle("app:ensure-data-dir", ensureDataDir);
  ipcMain.handle("app:open-data-dir", async () => {
    await ensureDir(dataDir());
    await shell.openPath(dataDir());
  });
  ipcMain.handle("app:open-path", async (_event: IpcMainInvokeEvent, { path: target }: { path: string }) => shell.openPath(target));
  ipcMain.handle("app:open-external", async (_event: IpcMainInvokeEvent, { url }: { url: string }) => {
    if (!isSafeExternalUrl(url)) {
      throw new Error(`不允许打开的外部地址: ${String(url)}`);
    }
    return shell.openExternal(String(url));
  });
  // 本地路径 -> file:// URL，供 markdown 内联图片等渲染使用
  ipcMain.handle("app:file-url", (_event: IpcMainInvokeEvent, { path: target }: { path: string }) => pathToFileURL(target).toString());
  ipcMain.handle("dialog:pick-directory", async () => {
    const result = await dialog.showOpenDialog(getMainWindow() as BrowserWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-text-file", async () => {
    const result = await dialog.showOpenDialog(getMainWindow() as BrowserWindow, {
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
    const result = await dialog.showOpenDialog(getMainWindow() as BrowserWindow, {
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
    const result = await dialog.showOpenDialog(getMainWindow() as BrowserWindow, {
      properties: ["openFile"],
      filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("window:minimize", (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:toggle-maximize", (event: IpcMainInvokeEvent) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("window:set-title", (event: IpcMainInvokeEvent, { title }: { title: string }) => BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title || APP_NAME)));
  ipcMain.handle("window:is-maximized", (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false);
}

export { register };
