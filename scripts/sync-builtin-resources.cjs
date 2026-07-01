#!/usr/bin/env node
// Mirror repository builtin resources into the Electron userData directory.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { APP_NAME } = require("../electron/lib/constants.cjs");

const repoRoot = path.resolve(__dirname, "..");
const dryRun = process.argv.includes("--dry-run");

const mappings = [
  { label: "Skills", source: ["resources", "builtin", "skills"], target: ["skills", "builtin"] },
  { label: "Agents", source: ["resources", "builtin", "agents"], target: ["agents", "builtin"] },
  { label: "MCP", source: ["resources", "builtin", "mcp"], target: ["mcp", "builtin"] },
];

function appDataDir() {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function userDataDir() {
  if (process.env.POLARAGENT_USER_DATA_DIR) {
    return path.resolve(process.env.POLARAGENT_USER_DATA_DIR);
  }
  return path.join(appDataDir(), APP_NAME);
}

function assertInsideUserData(target, baseDir) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedBase && !resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error(`Refusing to replace directory outside userData: ${resolvedTarget}`);
  }
}

async function mirrorDirectory(source, target, baseDir) {
  if (!fs.existsSync(source)) {
    console.warn(`[sync-builtin] Skip missing source: ${source}`);
    return;
  }

  assertInsideUserData(target, baseDir);
  if (dryRun) {
    console.log(`[sync-builtin] Would replace ${target} from ${source}`);
    return;
  }

  await fsp.rm(target, { recursive: true, force: true });
  await fsp.mkdir(target, { recursive: true });
  await fsp.cp(source, target, { recursive: true, force: true });
  console.log(`[sync-builtin] Synced ${target}`);
}

async function main() {
  const dataDir = userDataDir();
  if (!dryRun) await fsp.mkdir(dataDir, { recursive: true });

  console.log(`[sync-builtin] userData: ${dataDir}`);
  for (const mapping of mappings) {
    const source = path.join(repoRoot, ...mapping.source);
    const target = path.join(dataDir, ...mapping.target);
    await mirrorDirectory(source, target, dataDir);
  }
}

main().catch((error) => {
  console.error("[sync-builtin] Failed:", error);
  process.exitCode = 1;
});
