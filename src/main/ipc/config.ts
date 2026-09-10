// IPC：配置读写（普通配置文件 + AGENTS.md）
import fsp from "node:fs/promises";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { dataDir } from "../lib/app-paths.js";
import { readText, writeJsonFile } from "../lib/fs-utils.js";

// config 子目录下的普通配置文件路径
function configPath(fileName: string): string {
  return path.join(dataDir(), "config", fileName);
}

// AGENTS.md 固定路径
function agentsMdPath(): string {
  return path.join(dataDir(), "AGENTS.md");
}

function register(ipcMain: IpcMain) {
  ipcMain.handle("config:read", (_event: IpcMainInvokeEvent, { fileName }: { fileName: string }) => readText(configPath(fileName)));
  ipcMain.handle("config:write", (_event: IpcMainInvokeEvent, { fileName, content }: { fileName: string; content: string }) => writeJsonFile(configPath(fileName), content));
  // AGENTS.md 读写：固定 dataDir/AGENTS.md
  ipcMain.handle("config:read-agents-md", async () => {
    try {
      return await readText(agentsMdPath());
    } catch {
      return "";
    }
  });
  ipcMain.handle("config:write-agents-md", async (_event: IpcMainInvokeEvent, { content }: { content: string }) => {
    await fsp.mkdir(dataDir(), { recursive: true });
    await fsp.writeFile(agentsMdPath(), content, "utf-8");
  });
}

export { register };
