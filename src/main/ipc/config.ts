// IPC：配置读写（普通配置文件 + agents/mcp 两类带 builtin/custom 区分的配置）
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

// 带类型的配置根目录
function typedConfigDir(kind: string): string {
  if (kind === "agents") return path.join(dataDir(), "agents");
  if (kind === "mcp") return path.join(dataDir(), "mcp");
  throw new Error(`Unknown config kind: ${kind}`);
}

// 列举目录（或其多个子目录）下的全部 JSON id —— 复用 fs-utils.listJsonIds

// 读取带类型配置（agents 先查 custom 再查 builtin）
async function readTypedConfig(kind: string, id: string): Promise<string> {
  const base = typedConfigDir(kind);
  const candidates =
    kind === "agents"
      ? [path.join(base, "custom", `${id}.json`), path.join(base, "builtin", `${id}.json`)]
      : [path.join(base, `${id}.json`)];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`${kind} config not found: ${id}`);
  return readText(file);
}

// 写入带类型配置（agents 按 type 落入 builtin/custom）
async function writeTypedConfig(kind: string, id: string, content: string): Promise<void> {
  const parsed: { type?: string } = JSON.parse(content);
  const base = typedConfigDir(kind);
  const file =
    kind === "agents"
      ? path.join(base, parsed.type === "builtin" ? "builtin" : "custom", `${id}.json`)
      : path.join(base, `${id}.json`);
  await writeJsonFile(file, content);
}

// 删除带类型配置（agents 同时清理 custom/builtin 两处）
async function deleteTypedConfig(kind: string, id: string): Promise<void> {
  const base = typedConfigDir(kind);
  const candidates =
    kind === "agents"
      ? [path.join(base, "custom", `${id}.json`), path.join(base, "builtin", `${id}.json`)]
      : [path.join(base, `${id}.json`)];
  await pMap(
    candidates,
    (file: string) => fsp.rm(file, { force: true }).catch(() => {}),
    LOCAL_IO_CONCURRENCY,
  );
}

function register(ipcMain: IpcMain) {
  ipcMain.handle("config:read", (_event: IpcMainInvokeEvent, { fileName }: { fileName: string }) => readText(configPath(fileName)));
  ipcMain.handle("config:write", (_event: IpcMainInvokeEvent, { fileName, content }: { fileName: string; content: string }) => writeJsonFile(configPath(fileName), content));
  ipcMain.handle("config:list-agents", () => listJsonIds(path.join(dataDir(), "agents"), ["builtin", "custom"]));
  ipcMain.handle("config:read-agent", (_event: IpcMainInvokeEvent, { agentId }: { agentId: string }) => readTypedConfig("agents", agentId));
  ipcMain.handle("config:write-agent", (_event: IpcMainInvokeEvent, { agentId, content }: { agentId: string; content: string }) => writeTypedConfig("agents", agentId, content));
  ipcMain.handle("config:delete-agent", (_event: IpcMainInvokeEvent, { agentId }: { agentId: string }) => deleteTypedConfig("agents", agentId));
  ipcMain.handle("config:list-mcp", () => listJsonIds(path.join(dataDir(), "mcp")));
  ipcMain.handle("config:read-mcp", (_event: IpcMainInvokeEvent, { mcpId }: { mcpId: string }) => readTypedConfig("mcp", mcpId));
  ipcMain.handle("config:write-mcp", (_event: IpcMainInvokeEvent, { mcpId, content }: { mcpId: string; content: string }) => writeTypedConfig("mcp", mcpId, content));
  ipcMain.handle("config:delete-mcp", (_event: IpcMainInvokeEvent, { mcpId }: { mcpId: string }) => deleteTypedConfig("mcp", mcpId));
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
