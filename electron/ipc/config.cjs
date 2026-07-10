// IPC：配置读写（普通配置文件 + agents/mcp 两类带 builtin/custom 区分的配置）
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { dataDir } = require("../lib/app-paths.cjs");
const { readText, writeJsonFile, listJsonIds } = require("../lib/fs-utils.cjs");
const { pMap, LOCAL_IO_CONCURRENCY } = require("../lib/concurrency.cjs");

// config 子目录下的普通配置文件路径
function configPath(fileName) {
  return path.join(dataDir(), "config", fileName);
}

// 带类型的配置根目录
function typedConfigDir(kind) {
  if (kind === "agents") return path.join(dataDir(), "agents");
  if (kind === "mcp") return path.join(dataDir(), "mcp");
  throw new Error(`Unknown config kind: ${kind}`);
}

// 列举目录（或其多个子目录）下的全部 JSON id —— 复用 fs-utils.listJsonIds

// 读取带类型配置（agents 先查 custom 再查 builtin）
async function readTypedConfig(kind, id) {
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
async function writeTypedConfig(kind, id, content) {
  const parsed = JSON.parse(content);
  const base = typedConfigDir(kind);
  const file =
    kind === "agents"
      ? path.join(base, parsed.type === "builtin" ? "builtin" : "custom", `${id}.json`)
      : path.join(base, `${id}.json`);
  await writeJsonFile(file, content);
}

// 删除带类型配置（agents 同时清理 custom/builtin 两处）
async function deleteTypedConfig(kind, id) {
  const base = typedConfigDir(kind);
  const candidates =
    kind === "agents"
      ? [path.join(base, "custom", `${id}.json`), path.join(base, "builtin", `${id}.json`)]
      : [path.join(base, `${id}.json`)];
  await pMap(
    candidates,
    (file) => fsp.rm(file, { force: true }).catch(() => {}),
    LOCAL_IO_CONCURRENCY,
  );
}

function register(ipcMain) {
  ipcMain.handle("config:read", (_event, { fileName }) => readText(configPath(fileName)));
  ipcMain.handle("config:write", (_event, { fileName, content }) => writeJsonFile(configPath(fileName), content));
  ipcMain.handle("config:list-agents", () => listJsonIds(path.join(dataDir(), "agents"), ["builtin", "custom"]));
  ipcMain.handle("config:read-agent", (_event, { agentId }) => readTypedConfig("agents", agentId));
  ipcMain.handle("config:write-agent", (_event, { agentId, content }) => writeTypedConfig("agents", agentId, content));
  ipcMain.handle("config:delete-agent", (_event, { agentId }) => deleteTypedConfig("agents", agentId));
  ipcMain.handle("config:list-mcp", () => listJsonIds(path.join(dataDir(), "mcp")));
  ipcMain.handle("config:read-mcp", (_event, { mcpId }) => readTypedConfig("mcp", mcpId));
  ipcMain.handle("config:write-mcp", (_event, { mcpId, content }) => writeTypedConfig("mcp", mcpId, content));
  ipcMain.handle("config:delete-mcp", (_event, { mcpId }) => deleteTypedConfig("mcp", mcpId));
  ipcMain.handle("config:fetch-builtin-mcp", async () => {
    const dir = path.join(dataDir(), "mcp", "builtin");
    const ids = await listJsonIds(dir);
    const configs = await pMap(
      ids,
      (id) => readText(path.join(dir, `${id}.json`)).then(JSON.parse),
      LOCAL_IO_CONCURRENCY,
    );
    return JSON.stringify(configs);
  });
}

module.exports = { register };
