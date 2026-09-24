// 插件注册表：设置面板与运行时**共用**的那一份插件清单。
//
// 为什么单独立一个模块（而不是让 ipc/plugins.ts 自己扫目录）：
// 设置面板要的「这个插件是什么、什么状态、要什么权限」与运行时装配时要的
// 「启用哪几个、它们的贡献物在哪」**必须是同一份答案**。这与 resources.ts
// 当初被抽出来是同一条理由 —— 面板看到的与实际生效的不能各有一份真相。
//
// ## 三件事分层
//
//  - `discovery.ts`：磁盘上有什么（读文件 + 校验），无状态；
//  - **本文件**：谁被启用了（持久化）+ 合并成 `PluginView[]`（面板要的形状）；
//  - 将来的 loader：把启用插件的贡献物接进技能 / 提示 / MCP 目录（P3）。
//
// ## `state` 的语义（别误读）
//
// 本模块的 `running` 意思是**"宿主接受了它，且没有加载错误"** ——
// 而不是"它的代码正在跑"。P2 阶段没有任何东西消费插件贡献物，所以一个合法的、
// 已启用的插件就是 `running`；等 T1 有了插件进程之后，进程起不来才会落进
// `load_error` / `crashed`。**不要让 `running` 暗示"有东西在运行"**，
// 否则将来接上进程时这个字段的含义会悄悄变一次。

import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, pluginDirName, pluginsDir } from "@/main/app/paths";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import type {
  OintPluginManifest,
  PluginContributionNames,
  PluginContributionSummary,
  PluginDiagnostic,
  PluginPermissionView,
  PluginState,
  PluginView,
} from "@/shared/contracts/plugin";
import { listPluginContributions, summariseContributions } from "./contributions";
import { type DiscoveredPlugin, discoverPlugins } from "./discovery";
import { assessPermissionRisk } from "./permission-risk";
import { pluginPartition, surfaceUrl } from "./surface-url";

/**
 * 启停状态的持久化形状。
 *
 * 只记**显式选择**：不在表里 = 跟随该来源的默认值。这与 settings 里
 * `systemMcpServerEnabled` 是同一条口径 —— 记"显式选择"而不是"一份禁用表"，
 * 因为默认值将来可能不一致，只记禁用的话"默认关的那个用户打开了"就无处可记。
 */
interface PluginStateFile {
  version: 1;
  enabled: Record<string, boolean>;
}

const STATE_FILE = "state.json";

/**
 * 各来源的启用默认值。
 *
 * **内置默认开、其余的默认关。** 内置插件是随包分发、逐条审过的（与内置技能、
 * 系统 MCP 预设同一条原则）；而用户装进来的包与开发目录引用都是"外部代码"，
 * 默认关着等用户点头，避免"装完就生效"。
 */
function defaultEnabled(source: DiscoveredPlugin["source"]): boolean {
  return source === "builtin";
}

/** 空贡献物：清单合法但一个贡献目录都没有时用（不是"没统计"，是真的没有） */
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

/** 清单坏掉 / 没扫到贡献物时的空名字清单（界面据此不展开任何名字） */
function emptyContributionNames(): PluginContributionNames {
  return { skills: [], prompts: [], subagents: [], mcpServers: [] };
}

/**
 * 把一个「磁盘上的发现结果」变成面板要的一行。
 *
 * 关键取舍：**清单坏了也要出现在列表里**。否则用户装了一个坏包，界面上什么都没多，
 * 他只会以为安装失败了 —— 而真实原因是清单里打错了一个字段。
 * 这时 `id` 退回目录名、`state` 是 `invalid`、`error` 里写着可读原因。
 */
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
      // 来源直接决定"宿主能不能删它的文件"（见 DiscoveredPlugin.removable 的说明）
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
      hasMain: false,
    };
  }

  const permissions: PluginPermissionView[] = manifest.permissions.map((id) => ({
    id,
    risk: assessPermissionRisk(id),
  }));
  // 范围（fs scope / 命令白名单）拼成可读串显示在权限旁边 —— 见契约里 scope 的说明
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
    /*
      warning 也显示出来：Agent Plugins 根上的未知字段是"报告并忽略"（规范的 MUST），
      但用户该看到"这个包里有 Oint 不认识的东西" —— 那是他判断这个包可不可信的线索之一。
    */
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
    // 钩子声明原样给界面（详情页逐条列出：PreToolUse 能拦住工具调用，用户要看见）
    hooks: manifest.hooks,
    hasMain: manifest.main !== undefined,
    surfaces: manifest.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      title: typeof surface.title === "string" ? surface.title : surface.title["zh-CN"],
      // URL 与分区都在这里算（见 PluginSurfaceInfo 的说明：一种形状，一个产地）
      url: surfaceUrl(manifest.id, surface.entry),
      partition: pluginPartition(manifest.id),
      // 尺寸原样透传（缺省由各展示层自己定：面板、对话框、窗口的兜底值不一样）
      ...(surface.width === undefined ? {} : { width: surface.width }),
      ...(surface.height === undefined ? {} : { height: surface.height }),
    })),
  };
}

/** 某个权限的可读范围串（没有范围时 undefined） */
function scopeFor(
  manifest: NonNullable<DiscoveredPlugin["manifest"]>,
  permissionId: string,
): string | undefined {
  if (permissionId.startsWith("fs.")) {
    const mode = permissionId.slice(3) as "read" | "write" | "delete";
    const rule = manifest.fs?.[mode];
    if (rule === undefined) return undefined;
    const root = rule.root ?? "workspace";
    const scope = rule.scope ?? [];
    return scope.length === 0 ? root : `${root}/${scope.join(",")}`;
  }
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
  /** 全部插件（内置 + 用户 + 开发），顺序：内置 → 用户 → 开发 */
  list(): PluginView[];
  /** 按 id 找一行；找不到返回 undefined */
  find(id: string): PluginView | undefined;
  /** 最近的诊断记录，按时间降序 */
  diagnostics(limit?: number): PluginDiagnostic[];
  /** 重新扫描磁盘并合并启停状态；返回扫描后的列表 */
  reload(): Promise<PluginView[]>;
  /**
   * 启用 / 停用一个插件并落盘，返回变更后的完整列表。
   *
   * **返回完整列表而不是 void**：与 IPC.mcp.* 的既有做法一致 —— 面板不必再拉一次，
   * 也不会出现「点了没反应」的中间态。一次操作可能连带影响别的行（id 撞车时
   * 被忽略的那一个），只回一行会让界面漏刷新。
   *
   * 找不到 id 时抛错：那不是"操作失败"，是调用方给了一个不存在的插件。
   */
  setEnabled(id: string, enabled: boolean): Promise<PluginView[]>;
  /**
   * 已启用且**清单合法**的插件：id、目录、清单。
   *
   * 给 contributions.ts 算贡献面用。为什么单开一个方法而不是把这些塞进
   * `PluginView`：后者要跨 IPC 发给渲染层，而插件目录与清单原文是宿主的内部数据 ——
   * 渲染层要的是已经映射好的 `permissions` / `surfaces`，发原文过去只是多一份暴露面。
   */
  enabledSources(): { id: string; dir: string; manifest: OintPluginManifest }[];
  /**
   * 按 id 取一个**清单合法**插件的目录与清单，**不看启停**。
   *
   * 与 `enabledSources()` 分开是必须的：卸载与导出都发生在**插件可能已经停用**的时候。
   * 用 `enabledSources()` 找目录的话，"停用之后卸载不了"（报"找不到插件目录"）——
   * 而那看起来像插件坏了，不像是一个查错了表的问题。
   */
  sourceOf(id: string): { id: string; dir: string; manifest: OintPluginManifest } | undefined;
  /** 是否已经扫过盘（避免每次 list 都做一次 IO） */
  readonly loaded: boolean;
  /**
   * 设置当前会话的工作目录。
   *
   * 渲染层在会话切换时调它，与 `resolveWorkingDir` 同一个口径。
   * **只影响项目级插件**（`<dir>/.oint/plugins/`）—— 数据目录里的插件与会话无关。
   */
  setWorkspaceDir(dir: string | undefined): void;
  /** 当前工作目录；没设置时 undefined（界面 exec 要拿它做默认 cwd 与允许根） */
  getWorkspaceDir(): string | undefined;
}

export interface PluginRegistryOptions {
  /** 数据根目录；缺省用 dataDir()（测试传临时目录） */
  dataDir?: string;
  /** 应用根目录；缺省不扫内置插件 */
  appPath?: string;
  warn?: (message: string) => void;
}

export function createPluginRegistry(options: PluginRegistryOptions = {}): PluginRegistry {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const resolveDataDir = (): string => options.dataDir ?? dataDir();

  let views: PluginView[] = [];
  /**
   * 清单合法的插件及其目录（含未启用的）。
   *
   * 与 `views` 分开存而不是塞进 PluginView：目录是宿主的内部路径，
   * 而 PluginView 要跨 IPC 发给渲染层（见 enabledSources 的说明）。
   */
  let sources: { id: string; dir: string; manifest: OintPluginManifest }[] = [];
  let diagnostics: PluginDiagnostic[] = [];
  let diagnosticSeq = 0;
  let loaded = false;
  /** 当前会话的工作目录；undefined = 还没有会话，项目级插件那一层跳过 */
  let workspaceDir: string | undefined;
  /** 显式启停选择；`reload` 时从磁盘读回 */
  let explicit = new Map<string, boolean>();

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
      // 文件不存在（首次启动）或坏掉：都按"没有任何显式选择"处理。
      // 这里**不报错** —— 启停状态丢了会回落到各来源的默认值，不是数据损坏。
      return new Map();
    }
  }

  async function writeState(): Promise<void> {
    const payload: PluginStateFile = {
      version: 1,
      enabled: Object.fromEntries(explicit),
    };
    const target = path.join(pluginsDir(resolveDataDir()), STATE_FILE);
    /*
      **必须先建目录。** `writeFileAtomic` 只做"写临时文件 + rename"，不建父目录
      —— 而 `<dataDir>/plugins/` 在全新安装（或用户一个插件都没装）时并不存在，
      于是"启用一个内置插件"会以 ENOENT 失败。
      实测踩过：插件目录只在有 installed/ 插件被扫到时才会被创建。
      与 settings store 的 save 同款（那里也先 mkdir）。
    */
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

    /*
      id 撞车检测。
      插件**不像技能那样"同名覆盖"**：两个插件是两个独立的东西，同 id 只会让
      数据目录、权限作用域、界面 id 全部对不上。所以第一个胜出（来源顺序即
      内置 → 用户 → 开发），后面的记一条明确的诊断 —— 而不是静默丢掉。
    */
    const seen = new Set<string>();
    const next: PluginView[] = [];
    const nextSources: { id: string; dir: string; manifest: OintPluginManifest }[] = [];
    diagnostics = [];
    diagnosticSeq = 0;

    /*
      贡献物**先并行算完**，再进下面那个串行循环。

      为什么不能就地在循环里 await：算它要扫目录（每个插件最多三次 readdir），
      串起来 N 个插件就是 3N 次顺序 IO。而循环本身必须串行 —— id 撞车检测是
      "先到先得"，并发跑会让"谁先"取决于 IO 完成顺序，那是不确定的。
      按**下标**存而不是按 id：撞车时两个插件同 id，按 id 存会互相覆盖。

      **一次 IO 出两份产物**：名字清单（界面展开要显示"是哪几个"）与计数摘要
      （界面行上的"技能 2"）。计数由 `summariseContributions` 从同一份名字导出 ——
      分两路算的话，行上的数字与展开的名字会在某次改动后各说各话。
    */
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
      // 只有清单合法的插件才有目录可言 —— 坏包不该参与贡献面计算
      if (plugin.manifest !== undefined)
        nextSources.push({ id, dir: plugin.dir, manifest: plugin.manifest });

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
    list: () => [...views],
    find: (id) => views.find((item) => item.id === id),
    diagnostics: (limit) => (limit === undefined ? [...diagnostics] : diagnostics.slice(0, limit)),
    reload,
    sourceOf: (id) => {
      const found = sources.find((source) => source.id === id);
      return found === undefined ? undefined : { ...found };
    },

    enabledSources: () => {
      // 以 views 的当前启停为准（setEnabled 改的是 views，sources 不动）
      const on = new Set(views.filter((view) => view.enabled).map((view) => view.id));
      return sources.filter((source) => on.has(source.id)).map((source) => ({ ...source }));
    },

    async setEnabled(id, enabled) {
      const view = views.find((item) => item.id === id);
      if (view === undefined) throw new Error(`找不到插件：${id}`);

      /*
        先落盘再改内存：写失败时不该让界面"看起来已经改了"。
        这条与 settings store 的 save 同款（落盘成功后才更新缓存）。
      */
      explicit.set(id, enabled);
      try {
        await writeState();
      } catch (error) {
        // 回滚显式选择，保持内存与磁盘一致
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
      // 值没变就不动：`reload()` 是每次打开插件管理都会跑的，而每次重算
      // discoverPlugins 都会白扫一遍目录
      if (dir === workspaceDir) return;
      workspaceDir = dir;
    },

    get loaded() {
      return loaded;
    },
  };
}

/**
 * 启停之后的 `state`。
 *
 * 两条不能弄反的规则：
 *  - **清单不合法（`invalid`）时启停不改变状态** —— 打开一个坏包不会让它变好，
 *    把它显示成 `running` 会让用户以为"再点一次就好了"；
 *  - 其余情况启用即 `running`（宿主已接受、无加载错误），停用即 `disabled`。
 *    `state` 的语义见文件头，别把它读成"有代码在跑"。
 */
function nextState(view: PluginView, enabled: boolean): PluginState {
  if (view.state === "invalid") return "invalid";
  return enabled ? "running" : "disabled";
}

/**
 * 进程内唯一实例。
 *
 * 与 getMcpServers / getSharedPermissionRuleStore 同一手法：运行时与设置面板
 * 共用一份，避免两边各持一张表而对不上。
 */
let shared: PluginRegistry | null = null;

/** 取共享注册表；options 只在首次调用时生效 */
export function getPluginRegistry(options?: PluginRegistryOptions): PluginRegistry {
  shared ??= createPluginRegistry(options);
  return shared;
}
