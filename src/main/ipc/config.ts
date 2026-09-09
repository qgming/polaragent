// IPC：配置读写（普通配置文件 + mcp 带 builtin/custom 区分的配置）
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { dataDir } from "../lib/app-paths.js";
import { readText, writeJsonFile, listJsonIds } from "../lib/fs-utils.js";
import { pMap, LOCAL_IO_CONCURRENCY } from "../lib/concurrency.js";

// config 子目录下的普通配置文件路径
function configPath(fileName: string): string {
  return path.join(dataDir(), "config", fileName);
}

// 带类型的配置根目录（目前仅 mcp）
function typedConfigDir(kind: string): string {
  if (kind === "mcp") return path.join(dataDir(), "mcp");
  throw new Error(`Unknown config kind: ${kind}`);
}

// 列举目录（或其多个子目录）下的全部 JSON id —— 复用 fs-utils.listJsonIds

// 读取带类型配置
async function readTypedConfig(kind: string, id: string): Promise<string> {
  const base = typedConfigDir(kind);
  const file = path.join(base, `${id}.json`);
  if (!fs.existsSync(file)) throw new Error(`${kind} config not found: ${id}`);
  return readText(file);
}

// 写入带类型配置
async function writeTypedConfig(kind: string, id: string, content: string): Promise<void> {
  JSON.parse(content); // 校验 JSON 合法性
  const file = path.join(typedConfigDir(kind), `${id}.json`);
  await writeJsonFile(file, content);
}

// 删除带类型配置
async function deleteTypedConfig(kind: string, id: string): Promise<void> {
  const file = path.join(typedConfigDir(kind), `${id}.json`);
  await fsp.rm(file, { force: true }).catch(() => {});
}

// AGENTS.md 固定路径
function agentsMdPath(): string {
  return path.join(dataDir(), "AGENTS.md");
}

function register(ipcMain: IpcMain) {
  ipcMain.handle("config:read", (_event: IpcMainInvokeEvent, { fileName }: { fileName: string }) => readText(configPath(fileName)));
  ipcMain.handle("config:write", (_event: IpcMainInvokeEvent, { fileName, content }: { fileName: string; content: string }) => writeJsonFile(configPath(fileName), content));
  ipcMain.handle("config:list-mcp", () => listJsonIds(path.join(dataDir(), "mcp")));
  ipcMain.handle("config:read-mcp", (_event: IpcMainInvokeEvent, { mcpId }: { mcpId: string }) => readTypedConfig("mcp", mcpId));
  ipcMain.handle("config:write-mcp", (_event: IpcMainInvokeEvent, { mcpId, content }: { mcpId: string; content: string }) => writeTypedConfig("mcp", mcpId, content));
  ipcMain.handle("config:delete-mcp", (_event: IpcMainInvokeEvent, { mcpId }: { mcpId: string }) => deleteTypedConfig("mcp", mcpId));
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
  ipcMain.handle("config:fetch-builtin-mcp", async () => {
    const dir = path.join(dataDir(), "mcp", "builtin");
    const ids = await listJsonIds(dir);
    const configs = await pMap(
      ids,
      (id: string) => readText(path.join(dir, `${id}.json`)).then((text) => JSON.parse(text) as unknown),
      LOCAL_IO_CONCURRENCY,
    );
    return JSON.stringify(configs);
  });
}

export { register };
