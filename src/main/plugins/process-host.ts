import { createHash } from "node:crypto";
import path from "node:path";
import type { JsonValue } from "@earendil-works/chord";
import { bundleFacetPackage } from "@earendil-works/chord/bundler";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readFacetBundleArtifact } from "@earendil-works/chord/node";
import {
  createRegistry,
  defineExtension,
  type Extension,
  hook,
  section,
  type ToolRegistration,
  ToolTask,
} from "@earendil-works/pi-durable";
import type { TSchema } from "typebox";
import { dataDir, pluginDataDir } from "@/main/app/paths";
import type { PluginCommandView, PluginPackage } from "@/shared/contracts/plugin";
import { type PluginAgentDescription, validateAgentDescription } from "./agent-service";
import { verifyPluginArtifact } from "./artifact";
import {
  type PluginProcess,
  type PluginProcessFactory,
  startPluginProcess,
} from "./plugin-process";

export interface PluginProcessSource {
  id: string;
  dir: string;
  manifest: PluginPackage;
  development?: boolean;
}
export interface PluginProcessIssue {
  pluginId: string;
  message: string;
  details: string[];
}
export interface PluginExtension {
  pluginId: string;
  extension: Extension;
  scopeDir?: string;
}
interface Running {
  source: PluginProcessSource;
  signature: string;
  process: PluginProcess;
  extension: Extension;
  description: PluginAgentDescription;
  unsubscribe: () => void;
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
export function pluginToolName(pluginId: string, tool: string): string {
  return `plugin_${key(pluginId)}_${tool}`;
}
function extensionName(source: PluginProcessSource): string {
  return `plugin:${source.id}:${key(source.dir)}`;
}

export interface PluginProcessHost {
  sync(sources: readonly PluginProcessSource[], workspaceDir?: string): Promise<void>;
  extensions(workspaceDir?: string): readonly PluginExtension[];
  subscribe(listener: () => void): () => void;
  commands(workspaceDir?: string): PluginCommandView[];
  runCommand(
    id: string,
    args: string,
    workspaceDir: string,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  issues(): PluginProcessIssue[];
  stopAll(): void;
  runningCount(): number;
  runtime(dir: string): {
    state: "running" | "crashed" | "load_error" | "loading";
    tools: number;
    commands: number;
    error?: string;
  };
}

export function createPluginProcessHost(
  options: { start?: PluginProcessFactory; onIssue?: (issue: PluginProcessIssue) => void } = {},
): PluginProcessHost {
  const running = new Map<string, Running>();
  const snapshots = new Map<string, readonly PluginProcessSource[]>();
  const failed = new Map<string, { source: PluginProcessSource; extension: Extension }>();
  const listeners = new Set<() => void>();
  const issues = new Map<string, PluginProcessIssue>();
  let syncing = Promise.resolve();
  const start = options.start ?? startPluginProcess;
  const publish = (): void => {
    for (const listener of listeners) listener();
  };
  const note = (source: PluginProcessSource, message: string): void => {
    const issue = { pluginId: source.id, message, details: [] };
    issues.set(source.dir, issue);
    options.onIssue?.(issue);
  };
  function unavailable(source: PluginProcessSource, message: string): Extension {
    return defineExtension({
      name: extensionName(source),
      ...(source.manifest.hooks.includes("beforeTool")
        ? {
            hooks: [
              hook(ToolTask, {
                beforeTool: () => ({
                  block: `插件 ${source.manifest.name} 的策略不可用：${message}`,
                }),
              }),
            ],
          }
        : {}),
    });
  }
  function materialize(
    source: PluginProcessSource,
    process: PluginProcess,
    description: PluginAgentDescription,
  ): Extension {
    const tools: ToolRegistration[] = source.manifest.permissions.includes("agent.tool.register")
      ? description.tools.map((tool) => ({
          ...tool,
          name: pluginToolName(source.id, tool.name),
          parameters: tool.parameters as TSchema,
          async execute(args, api, context) {
            return process.invoke(
              (service, context) =>
                service.execute(
                  tool.name,
                  args as { [key: string]: JsonValue },
                  {
                    callId: api.callId,
                    taskId: String(api.taskId),
                    conversationId: String(api.conversationId),
                    cwd: api.env?.cwd ?? "",
                  },
                  context,
                ),
              context,
            );
          },
        }))
      : [];
    const extension = defineExtension({
      name: extensionName(source),
      tools,
      sections: description.sections.map((item) =>
        section(`p_${key(source.id)}_${item.key}`, () => item.text),
      ),
      hooks: source.manifest.permissions.includes("hostHooks.register")
        ? [
            hook(ToolTask, {
              ...(source.manifest.hooks.includes("beforeTool")
                ? {
                    beforeTool: (call, api, context) =>
                      process.invoke(
                        (service, context) =>
                          service.beforeTool(
                            call,
                            {
                              taskId: String(api.taskId),
                              conversationId: String(api.conversationId),
                            },
                            context,
                          ),
                        context,
                        5000,
                      ),
                  }
                : {}),
              ...(source.manifest.hooks.includes("afterTool")
                ? {
                    afterTool: (call, result, api, context) =>
                      process.invoke(
                        (service, context) =>
                          service.afterTool(
                            call,
                            result,
                            {
                              taskId: String(api.taskId),
                              conversationId: String(api.conversationId),
                            },
                            context,
                          ),
                        context,
                        5000,
                      ),
                  }
                : {}),
            }),
          ]
        : [],
    });
    // Validate the real native registration before any publication or worker retirement.
    createRegistry().install(extension);
    return extension;
  }
  async function reconcile(
    sources: readonly PluginProcessSource[],
    workspaceDir = "",
  ): Promise<void> {
    snapshots.set(workspaceDir ? path.resolve(workspaceDir) : "", sources);
    const desired = new Map(
      [...snapshots.values()].flatMap((sources) =>
        sources.map((source) => [source.dir, source] as const),
      ),
    );
    for (const [dir, entry] of running)
      if (!desired.has(dir)) {
        running.delete(dir);
        entry.unsubscribe();
        publish();
        entry.process.retire();
        issues.delete(dir);
      }
    for (const dir of failed.keys())
      if (!desired.has(dir)) {
        failed.delete(dir);
        issues.delete(dir);
      }
    for (const source of desired.values()) {
      if (!source.manifest.agentFacet) {
        const previous = running.get(source.dir);
        previous?.unsubscribe();
        previous?.process.retire();
        running.delete(source.dir);
        failed.delete(source.dir);
        issues.delete(source.dir);
        continue;
      }
      let candidate: PluginProcess | undefined;
      try {
        const manifestPath = path.join(source.dir, "dist", "chord-facets.json");
        if (source.development)
          await bundleFacetPackage({
            packagePath: source.dir,
            outdir: path.join(source.dir, "dist"),
          });
        await verifyPluginArtifact(source.dir, source.manifest);
        const artifact = await readFacetBundleArtifact({ manifestPath, entry: "agent" });
        if (artifact.plugin.id !== source.id || artifact.plugin.version !== source.manifest.version)
          throw new Error("Chord bundle identity differs from package.json");
        const signature = JSON.stringify([artifact.entry.integrity, source.manifest]);
        const previous = running.get(source.dir);
        if (previous?.signature === signature && previous.process.alive) continue;
        candidate = await start({
          pluginId: source.id,
          pluginDir: source.dir,
          manifestPath,
          dataDir: pluginDataDir(source.id, dataDir()),
          onExit(message) {
            const entry = running.get(source.dir);
            if (!entry || entry.process !== candidate) return;
            note(source, message);
            entry.extension = unavailable(source, message);
            publish();
          },
        });
        const process = candidate;
        const description = process.service.description.value;
        validateAgentDescription(description);
        const entry: Running = {
          source,
          signature,
          process,
          description,
          extension: materialize(source, process, description),
          unsubscribe: () => {},
        };
        entry.unsubscribe = process.service.description.subscribe((value) => {
          if (running.get(source.dir) !== entry) return;
          try {
            validateAgentDescription(value);
            const extension = materialize(source, process, value);
            entry.description = value;
            entry.extension = extension;
            issues.delete(source.dir);
          } catch (error) {
            const message = String(error);
            note(source, message);
          }
          publish();
        });
        running.set(source.dir, entry);
        failed.delete(source.dir);
        issues.delete(source.dir);
        // Consumers install the new native definitions before the old worker can close.
        publish();
        previous?.unsubscribe();
        previous?.process.retire();
      } catch (error) {
        candidate?.stop();
        const message = error instanceof Error ? error.message : String(error);
        note(source, message);
        // A failed candidate never tears down a healthy published generation.
        if (!running.get(source.dir)?.process.alive)
          failed.set(source.dir, { source, extension: unavailable(source, message) });
      }
    }
    publish();
  }
  const selected = (cwd = ""): readonly PluginProcessSource[] =>
    snapshots.get(cwd ? path.resolve(cwd) : "") ?? snapshots.get("") ?? [];
  function commands(cwd = ""): PluginCommandView[] {
    return selected(cwd).flatMap((source) =>
      source.manifest.permissions.includes("commands.register")
        ? (running.get(source.dir)?.description.commands ?? []).map((command) => ({
            ...command,
            id: `${key(source.dir)}:${command.name}`,
            pluginId: source.id,
            pluginName: source.manifest.name,
          }))
        : [],
    );
  }
  return {
    sync(sources, cwd) {
      const next = syncing.then(() => reconcile(sources, cwd));
      syncing = next.catch(() => undefined);
      return next;
    },
    extensions(cwd) {
      return selected(cwd).flatMap((source) => {
        const entry = running.get(source.dir) ?? failed.get(source.dir);
        return entry ? [{ pluginId: source.id, extension: entry.extension }] : [];
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    commands,
    async runCommand(id, args, cwd) {
      const command = commands(cwd).find((command) => command.id === id);
      if (!command) return { ok: false, error: "插件命令不可用" };
      const source = selected(cwd).find((source) => source.id === command.pluginId);
      const entry = source && running.get(source.dir);
      if (!entry) return { ok: false, error: "插件进程不可用" };
      try {
        return {
          ok: true,
          text: await entry.process.invoke(
            (service, context) => service.command(command.name, args, cwd, context),
            BACKGROUND_CONTEXT,
          ),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    issues: () => [...issues.values()],
    runningCount: () => running.size,
    runtime(dir) {
      const entry = running.get(dir);
      const issue = issues.get(dir);
      return {
        state: entry
          ? entry.process.alive
            ? "running"
            : "crashed"
          : failed.has(dir)
            ? "load_error"
            : "loading",
        tools: entry?.extension.tools?.length ?? 0,
        commands: entry?.description.commands.length ?? 0,
        ...(issue ? { error: issue.message } : {}),
      };
    },
    stopAll() {
      for (const entry of running.values()) {
        entry.unsubscribe();
        entry.process.stop();
      }
      running.clear();
      snapshots.clear();
      failed.clear();
      publish();
    },
  };
}
let shared: PluginProcessHost | undefined;
export function getPluginProcessHost(): PluginProcessHost {
  shared ??= createPluginProcessHost();
  return shared;
}
export function pluginExtensions(cwd?: string): readonly PluginExtension[] {
  return getPluginProcessHost().extensions(cwd);
}
export function subscribePluginExtensions(listener: () => void): () => void {
  return getPluginProcessHost().subscribe(listener);
}
export function pluginCommands(cwd?: string): PluginCommandView[] {
  return getPluginProcessHost().commands(cwd);
}
export function runPluginCommand(
  id: string,
  args: string,
  cwd: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  return getPluginProcessHost().runCommand(id, args, cwd);
}
export function pluginProcessIssues(): PluginProcessIssue[] {
  return getPluginProcessHost().issues();
}
export function stopPluginProcesses(): void {
  getPluginProcessHost().stopAll();
}
