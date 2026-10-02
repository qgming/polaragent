import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pluginDirName, pluginsDir } from "@/main/app/paths";
import type { PluginManifestIssue, PluginPackage, PluginSource } from "@/shared/contracts/plugin";
import { validatePluginManifest } from "./manifest";

export const PLUGIN_MANIFEST_FILE = "package.json";

export interface DiscoveredPlugin {
  dir: string;
  workspaceDir?: string;
  source: PluginSource;
  manifestPath: string;

  manifest?: PluginPackage;

  removable: boolean;

  loadError?: string;

  issues: PluginManifestIssue[];
}

export interface DiscoverOptions {
  dataDir: string;

  appPath?: string;

  workspaceDir?: string;
}

async function listSubdirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function readPluginManifest(dir: string): Promise<DiscoveredPlugin> {
  const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILE);
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      dir,
      source: "user",
      removable: true,
      manifestPath,
      loadError:
        code === "ENOENT"
          ? `插件目录里没有 ${PLUGIN_MANIFEST_FILE}`
          : `读不到 ${PLUGIN_MANIFEST_FILE}：${String(error)}`,
      issues: [],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      dir,
      source: "user",
      removable: true,
      manifestPath,
      loadError: `${PLUGIN_MANIFEST_FILE} 不是合法 JSON：${
        error instanceof Error ? error.message : String(error)
      }`,
      issues: [],
    };
  }

  const result = validatePluginManifest(parsed);
  return result.ok
    ? {
        dir,
        source: "user",
        removable: true,
        manifestPath,
        manifest: result.manifest,
        issues: result.warnings,
      }
    : { dir, source: "user", removable: true, manifestPath, issues: result.issues };
}

async function discoverInstalled(dataDir: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(pluginsDir(dataDir), "installed");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({ ...plugin, source: "user" as const }));
}

async function discoverBuiltin(appPath: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(appPath, "resources", "plugins");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({ ...plugin, source: "builtin" as const, removable: false }));
}

export const DEV_PLUGINS_FILE = "dev.json";

export async function readDevPluginDirs(dataDir: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(pluginsDir(dataDir), DEV_PLUGINS_FILE), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string" && entry !== "");
  } catch {
    return [];
  }
}

async function discoverDev(dataDir: string): Promise<DiscoveredPlugin[]> {
  const dirs = await readDevPluginDirs(dataDir);
  const found = await Promise.all(
    dirs.map(async (dir) => {
      const info = await stat(dir).catch(() => undefined);
      if (info === undefined || !info.isDirectory()) {
        return {
          dir,
          source: "dev" as const,
          removable: true,
          manifestPath: path.join(dir, PLUGIN_MANIFEST_FILE),
          loadError: `开发插件目录不存在或不是目录：${dir}`,
          issues: [],
        };
      }
      const plugin = await readPluginManifest(dir);
      return { ...plugin, source: "dev" as const, removable: true };
    }),
  );
  return found;
}

async function discoverProject(workspaceDir: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(workspaceDir, ".oint", "plugins");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({
    ...plugin,
    source: "dev" as const,
    removable: false,
    workspaceDir: path.resolve(workspaceDir),
  }));
}

export async function discoverPlugins(options: DiscoverOptions): Promise<DiscoveredPlugin[]> {
  const { appPath, workspaceDir } = options;
  const [builtin, project, installed, dev] = await Promise.all([
    appPath === undefined || appPath === "" ? Promise.resolve([]) : discoverBuiltin(appPath),
    workspaceDir === undefined || workspaceDir === ""
      ? Promise.resolve([])
      : discoverProject(workspaceDir),
    discoverInstalled(options.dataDir),
    discoverDev(options.dataDir),
  ]);
  return [...builtin, ...project, ...installed, ...dev];
}

export { pluginDirName };
