import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, pluginDirName, pluginsDir } from "@/main/app/paths";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import type {
  PluginContributionNames,
  PluginContributionSummary,
  PluginDiagnostic,
  PluginPackage,
  PluginPermissionView,
  PluginState,
  PluginView,
} from "@/shared/contracts/plugin";
import { listPluginContributions, summariseContributions } from "./contributions-paths";
import { type DiscoveredPlugin, discoverPlugins } from "./discovery";
import { assessPermissionRisk } from "./permission-risk";
import { getPluginProcessHost } from "./process-host";
import { pluginPartition, surfaceUrl } from "./surface-url";

interface PluginStateFile {
  version: 1;
  enabled: Record<string, boolean>;
}

const STATE_FILE = "state.json";

function defaultEnabled(source: DiscoveredPlugin["source"]): boolean {
  return source === "builtin";
}

function emptyContributions(): PluginContributionSummary {
  return {
    panels: 0,
    modals: 0,
    windows: 0,
    commands: 0,
    skills: 0,
    prompts: 0,
    subagents: 0,
    mcpServers: 0,
    tools: 0,
  };
}

function emptyContributionNames(): PluginContributionNames {
  return { skills: [], prompts: [], subagents: [], mcpServers: [] };
}

function toView(
  plugin: DiscoveredPlugin,
  enabled: boolean,
  contributions: PluginContributionSummary,
  contributionNames: PluginContributionNames,
): PluginView {
  const manifest = plugin.manifest;
  const fallbackId = pluginDirName(path.basename(plugin.dir));

  if (manifest === undefined) {
    return {
      id: fallbackId,
      name: fallbackId,
      version: "",
      description: "",
      source: plugin.source,
      removable: plugin.removable,
      enabled,
      state: "invalid",
      error:
        plugin.loadError ??
        plugin.issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"),
      contributions: emptyContributions(),
      contributionNames: emptyContributionNames(),
      permissions: [],
      newlyRequested: [],
      hooks: [],
      surfaces: [],
      hasCode: false,
    };
  }

  const permissions: PluginPermissionView[] = manifest.permissions.map((id) => ({
    id,
    risk: assessPermissionRisk(id),
  }));
  for (const permission of permissions) {
    const scope = scopeFor(manifest, permission.id);
    if (scope !== undefined) permission.scope = scope;
  }

  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    source: plugin.source,
    removable: plugin.removable,
    enabled,
    state: enabled ? "running" : "disabled",

    ...(plugin.issues.length === 0
      ? {}
      : {
          error: plugin.issues
            .map(
              (issue) =>
                `${issue.severity === "error" ? "错误" : "提示"}：${issue.path} ${issue.message}`,
            )
            .join("\n"),
        }),
    contributions,
    contributionNames,
    permissions,
    newlyRequested: [],
    hooks: manifest.hooks,
    hasCode: manifest.agentFacet !== undefined,
    surfaces: manifest.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      title: typeof surface.title === "string" ? surface.title : surface.title["zh-CN"],
      url: surfaceUrl(manifest.id, surface.entry),
      partition: pluginPartition(manifest.id, plugin.workspaceDir),
      ...(surface.width === undefined ? {} : { width: surface.width }),
      ...(surface.height === undefined ? {} : { height: surface.height }),
    })),
  };
}

function scopeFor(
  manifest: NonNullable<DiscoveredPlugin["manifest"]>,
  permissionId: string,
): string | undefined {
  if (permissionId === "shell.exec") {
    const exec = manifest.shell?.exec ?? [];
    return exec.length === 0 ? undefined : exec.join(" ");
  }
  if (permissionId === "net.fetch") {
    const domains = manifest.net?.domains ?? [];
    return domains.length === 0 ? undefined : domains.join(" ");
  }
  return undefined;
}

export interface PluginRegistry {
  list(): PluginView[];

  find(id: string): PluginView | undefined;

  diagnostics(limit?: number): PluginDiagnostic[];

  reload(): Promise<PluginView[]>;

  setEnabled(id: string, enabled: boolean): Promise<PluginView[]>;

  enabledSources(): {
    id: string;
    dir: string;
    manifest: PluginPackage;
    workspaceDir?: string;
    development?: boolean;
  }[];

  sourceOf(id: string):
    | {
        id: string;
        dir: string;
        manifest: PluginPackage;
        workspaceDir?: string;
        development?: boolean;
      }
    | undefined;

  readonly loaded: boolean;

  setWorkspaceDir(dir: string | undefined): void;

  getWorkspaceDir(): string | undefined;
}

export interface PluginRegistryOptions {
  dataDir?: string;

  appPath?: string;
  warn?: (message: string) => void;
}

export function createPluginRegistry(options: PluginRegistryOptions = {}): PluginRegistry {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const resolveDataDir = (): string => options.dataDir ?? dataDir();

  let views: PluginView[] = [];

  let sources: {
    id: string;
    dir: string;
    manifest: PluginPackage;
    workspaceDir?: string;
    development?: boolean;
  }[] = [];
  let diagnostics: PluginDiagnostic[] = [];
  let diagnosticSeq = 0;
  let loaded = false;

  let workspaceDir: string | undefined;

  let explicit = new Map<string, boolean>();

  function liveView(view: PluginView): PluginView {
    if (!view.enabled || !view.hasCode || view.state === "invalid") return view;
    const source = sources.find((source) => source.id === view.id);
    if (!source) return view;
    const status = getPluginProcessHost().runtime(source.dir);
    return {
      ...view,
      state: status.state,
      ...(status.error ? { error: status.error } : {}),
      contributions: { ...view.contributions, tools: status.tools, commands: status.commands },
    };
  }

  async function readState(): Promise<Map<string, boolean>> {
    try {
      const raw = await readFile(path.join(pluginsDir(resolveDataDir()), STATE_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<PluginStateFile>;
      const enabled = parsed.enabled;
      if (typeof enabled !== "object" || enabled === null) return new Map();
      return new Map(
        Object.entries(enabled).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      );
    } catch {
      return new Map();
    }
  }

  async function writeState(): Promise<void> {
    const payload: PluginStateFile = {
      version: 1,
      enabled: Object.fromEntries(explicit),
    };
    const target = path.join(pluginsDir(resolveDataDir()), STATE_FILE);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, `${JSON.stringify(payload, null, 2)}\n`);
  }

  function note(pluginId: string, level: "warn" | "error", event: string, message: string): void {
    diagnosticSeq += 1;
    diagnostics = [
      { pluginId, seq: diagnosticSeq, level, event, message, at: Date.now() },
      ...diagnostics,
    ].slice(0, 500);
  }

  async function reload(): Promise<PluginView[]> {
    explicit = await readState();
    const found = await discoverPlugins({
      dataDir: resolveDataDir(),
      ...(options.appPath === undefined ? {} : { appPath: options.appPath }),
      ...(workspaceDir === undefined ? {} : { workspaceDir }),
    });

    const seen = new Set<string>();
    const next: PluginView[] = [];
    const nextSources: {
      id: string;
      dir: string;
      manifest: PluginPackage;
      workspaceDir?: string;
      development?: boolean;
    }[] = [];
    diagnostics = [];
    diagnosticSeq = 0;

    const contributions = new Map<number, PluginContributionNames>();
    await Promise.all(
      found.map(async (plugin, index) => {
        if (plugin.manifest === undefined) return;
        contributions.set(index, await listPluginContributions(plugin.dir));
      }),
    );

    for (const [index, plugin] of found.entries()) {
      const id = plugin.manifest?.id ?? pluginDirName(path.basename(plugin.dir));
      if (seen.has(id)) {
        note(
          id,
          "error",
          "duplicate.id",
          `插件 id "${id}" 重复，已忽略后发现的这一个：${plugin.dir}`,
        );
        warn(`插件 id 重复，已忽略：${id}（${plugin.dir}）`);
        continue;
      }
      seen.add(id);

      const enabled = explicit.get(id) ?? defaultEnabled(plugin.source);
      const names = contributions.get(index) ?? emptyContributionNames();
      const view = toView(
        plugin,
        enabled,
        plugin.manifest === undefined
          ? emptyContributions()
          : summariseContributions(plugin.manifest, names),
        names,
      );
      next.push(view);
      if (plugin.manifest !== undefined)
        nextSources.push({
          id,
          dir: plugin.dir,
          manifest: plugin.manifest,
          development: plugin.source === "dev",
          workspaceDir: plugin.workspaceDir,
        });

      if (plugin.loadError !== undefined) {
        note(id, "error", "load.error", plugin.loadError);
      } else {
        for (const issue of plugin.issues) {
          note(
            id,
            issue.severity === "error" ? "error" : "warn",
            "manifest.issue",
            `${issue.path} ${issue.message}`,
          );
        }
      }
    }

    views = next;
    sources = nextSources;
    loaded = true;
    return [...views];
  }

  return {
    list: () => views.map(liveView),
    find: (id) => {
      const view = views.find((item) => item.id === id);
      return view ? liveView(view) : undefined;
    },
    diagnostics: (limit) => (limit === undefined ? [...diagnostics] : diagnostics.slice(0, limit)),
    reload,
    sourceOf: (id) => {
      const found = sources.find((source) => source.id === id);
      return found === undefined ? undefined : { ...found };
    },

    enabledSources: () => {
      const on = new Set(views.filter((view) => view.enabled).map((view) => view.id));
      return sources.filter((source) => on.has(source.id)).map((source) => ({ ...source }));
    },

    async setEnabled(id, enabled) {
      const view = views.find((item) => item.id === id);
      if (view === undefined) throw new Error(`找不到插件：${id}`);

      explicit.set(id, enabled);
      try {
        await writeState();
      } catch (error) {
        explicit.delete(id);
        throw error;
      }

      views = views.map((item) =>
        item.id === id ? { ...item, enabled, state: nextState(item, enabled) } : item,
      );
      note(id, "warn", enabled ? "plugin.enable" : "plugin.disable", enabled ? "已启用" : "已停用");
      return [...views];
    },

    getWorkspaceDir: () => workspaceDir,

    setWorkspaceDir(dir) {
      if (dir === workspaceDir) return;
      workspaceDir = dir;
    },

    get loaded() {
      return loaded;
    },
  };
}

function nextState(view: PluginView, enabled: boolean): PluginState {
  if (view.state === "invalid") return "invalid";
  return enabled ? "running" : "disabled";
}

let shared: PluginRegistry | null = null;

export function getPluginRegistry(options?: PluginRegistryOptions): PluginRegistry {
  shared ??= createPluginRegistry(options);
  return shared;
}
