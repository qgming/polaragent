import { createHash } from "node:crypto";
import path from "node:path";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import {
  contributionDirsOf,
  EMPTY_CONTRIBUTION_DIRS,
  type PluginContributionDirs,
  readMcpServers,
} from "./contributions-paths";
import {
  buildPluginMcpServers,
  type PluginMcpIssue,
  type PluginMcpServer,
  pluginServerId,
} from "./plugin-mcp";
import { getPluginProcessHost } from "./process-host";
import { createPluginRegistry, getPluginRegistry, type PluginRegistry } from "./registry";

export {
  contributionDirsOf,
  countPluginContributions,
  listPluginContributions,
  type PluginContributionDirs,
  readMcpServers,
  summariseContributions,
} from "./contributions-paths";

type Snapshot = {
  dirs: PluginContributionDirs;
  servers: PluginMcpServer[];
  issues: PluginMcpIssue[];
};
const snapshots = new Map<string, Snapshot>();
const workspaces = new Map<string, PluginRegistry>();
let appPath: string | undefined;
let refreshing = Promise.resolve();
const scopeKey = (cwd?: string): string => (cwd ? path.resolve(cwd) : "");
const currentKey = (): string => scopeKey(getPluginRegistry().getWorkspaceDir());
function snapshot(cwd?: string): Snapshot | undefined {
  return snapshots.get(scopeKey(cwd)) ?? snapshots.get("");
}

/** Session consumers always supply cwd; omission selects only global resources. */
export function pluginContributionDirs(cwd?: string): PluginContributionDirs {
  return snapshot(cwd)?.dirs ?? EMPTY_CONTRIBUTION_DIRS;
}
export function pluginMcpServerConfigs(cwd?: string): McpServerConfig[] {
  return snapshot(cwd)?.servers.map((server) => server.config) ?? [];
}
export function allPluginMcpServerConfigs(): McpServerConfig[] {
  return [
    ...new Map(
      [...snapshots.values()].flatMap((item) =>
        item.servers.map((server) => [server.config.id, server.config] as const),
      ),
    ).values(),
  ];
}
export function pluginMcpIssues(): PluginMcpIssue[] {
  return snapshots.get(currentKey())?.issues ?? [];
}
export function pluginMcpServers(cwd?: string): PluginMcpServer[] {
  return snapshot(cwd)?.servers ?? [];
}

async function refresh(registry: PluginRegistry, cwd?: string): Promise<void> {
  const sources = registry.enabledSources();
  const dirs: PluginContributionDirs = { skills: [], prompts: [], subagents: [], mcpFiles: [] };
  const results = await Promise.all(
    sources.map(async (source) => {
      const part = contributionDirsOf(source.dir);
      if (source.manifest.permissions.includes("skills.contribute"))
        dirs.skills.push(...part.skills);
      if (source.manifest.permissions.includes("prompts.contribute"))
        dirs.prompts.push(...part.prompts);
      if (source.manifest.permissions.includes("subagents.contribute"))
        dirs.subagents.push(...part.subagents);
      dirs.mcpFiles.push(...part.mcpFiles);
      const result = buildPluginMcpServers(source.manifest, await readMcpServers(part.mcpFiles[0]));
      const identity = createHash("sha256")
        .update(`${source.id}:${source.dir}`)
        .digest("hex")
        .slice(0, 12);
      result.servers = result.servers.map((server) => ({
        ...server,
        config: { ...server.config, id: pluginServerId(identity, server.memberName) },
      }));
      return result;
    }),
  );
  snapshots.set(scopeKey(cwd), {
    dirs,
    servers: results.flatMap((result) => result.servers),
    issues: results.flatMap((result) => result.issues),
  });
  await getPluginProcessHost().sync(sources, scopeKey(cwd));
}

/** Refresh every active workspace so a global enable/disable cannot leave stale session capabilities. */
export function refreshPluginContributions(
  options: { appPath?: string; registry?: PluginRegistry } = {},
): Promise<void> {
  appPath = options.appPath ?? appPath;
  const run = refreshing.then(async () => {
    const registry = options.registry ?? getPluginRegistry(options);
    await registry.reload();
    await refresh(registry, registry.getWorkspaceDir());
    if (options.registry) return;
    for (const [cwd, scoped] of workspaces) {
      if (cwd === scopeKey(registry.getWorkspaceDir())) continue;
      await scoped.reload();
      await refresh(scoped, cwd);
    }
    if (!workspaces.has("")) {
      const global = createPluginRegistry({ appPath });
      workspaces.set("", global);
      await global.reload();
      await refresh(global);
    }
  });
  refreshing = run.catch(() => undefined);
  return run;
}

/** Runtime calls this before constructing a session; UI selection never determines session scope. */
export function ensurePluginWorkspace(cwd: string): Promise<void> {
  const run = refreshing.then(async () => {
    const key = scopeKey(cwd);
    if (workspaces.has(key) && snapshots.has(key)) return;
    const registry = createPluginRegistry({ appPath });
    registry.setWorkspaceDir(key || undefined);
    workspaces.set(key, registry);
    await registry.reload();
    await refresh(registry, key);
  });
  refreshing = run.catch(() => undefined);
  return run;
}

export function isPluginContributionDir(dir: string): boolean {
  const target = path.resolve(dir).toLowerCase();
  return [...snapshots.values()].some(({ dirs }) =>
    [...dirs.skills, ...dirs.prompts, ...dirs.subagents].some(
      (candidate) => path.resolve(candidate).toLowerCase() === target,
    ),
  );
}
export function resetPluginContributionsForTest(): void {
  snapshots.clear();
  workspaces.clear();
}
