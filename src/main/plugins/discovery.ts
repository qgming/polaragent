// 插件发现：扫目录、读清单、校验，产出一份「磁盘上有什么」。
//
// ## 与 registry 的分工
//
// 这里只回答**"磁盘上有什么"**（含每个插件的清单与校验结果），不持有任何状态、
// 不管启停、不做生命周期。registry 在这之上叠加"用户启用了哪几个"与运行时状态。
// 分开的理由与 resources.ts 当初被抽出来一样：**同一条解析规则只能有一处**，
// 否则"面板看到的"与"运行时装配的"会各有一份真相。
//
// ## 三个来源
//
//  - `installed`：`<dataDir>/plugins/installed/<dir>/plugin.json` —— 装进来的包
//  - `dev`：`<dataDir>/plugins/dev.json` 里列的目录 —— 直接引用，不拷贝
//  - `builtin`：`<appPath>/resources/plugins/<dir>/plugin.json` —— 随包分发
//
// **顺序即优先级吗？不是。** 技能 / 子智能体那套是"同名用户覆盖内置"，
// 但插件**不覆盖** —— 两个插件是两个独立的东西，同名只会让 id 撞车（见 registry）。
// 所以这里三个来源只是并列扫出来，优先级交给 id 唯一性去管。

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pluginDirName, pluginsDir } from "@/main/app/paths";
import type {
  OintPluginManifest,
  PluginManifestIssue,
  PluginSource,
} from "@/shared/contracts/plugin";
import { validatePluginManifest } from "./manifest";

/** 清单文件名。Agent Plugins 规定它固定在插件根（§5.2） */
export const PLUGIN_MANIFEST_FILE = "plugin.json";

/** 一个被发现（并尝试校验）的插件 */
export interface DiscoveredPlugin {
  /** 插件目录的绝对路径 */
  dir: string;
  source: PluginSource;
  manifestPath: string;
  /**
   * 校验通过的清单。
   *
   * `undefined` 有三种可能，靠 `loadError` 与 `issues` 区分：
   *  - 磁盘层面失败（文件读不到 / JSON 坏了）→ `loadError` 有值；
   *  - 清单不合法 → `issues` 里全是 error；
   *  - **理论上不会**：校验通过就一定有 manifest。
   */
  manifest?: OintPluginManifest;
  /**
   * 宿主能不能**删掉它的文件**。
   *
   * `false` 有三种：内置（住在 asar 里）、项目目录（那是用户/模型的源码，
   * 宿主删它等于删用户的文件）。界面据此把「卸载」换成「打开所在目录」——
   * 一个点了只会报错的按钮比没有按钮更糟。
   */
  removable: boolean;
  /** 读文件或解析 JSON 的失败（与"清单不合法"是两件事） */
  loadError?: string;
  /** 校验问题（含 warning —— 校验通过时它们仍然有值，要透传给作者） */
  issues: PluginManifestIssue[];
}

export interface DiscoverOptions {
  /** 数据根目录（生产走 dataDir()，测试传临时目录） */
  dataDir: string;
  /** 应用根目录；不给就跳过内置插件（单测与不关心内置层的调用方可以省略） */
  appPath?: string;
  /**
   * 当前会话的工作目录；不给就**跳过项目级插件**（`<dir>/.oint/plugins/`）。
   *
   * 不给时跳过而不是猜一个：猜错会让 A 项目的插件出现在 B 项目的列表里，
   * 而那种错误看起来像"插件串了"，没人会想到是工作目录的问题。
   */
  workspaceDir?: string;
}

/** 目录名字典序，`installed` 的展示顺序因此稳定可复现 */
async function listSubdirs(parent: string): Promise<string[]> {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    // 目录还不存在（首次启动）或不可读：都按"没有插件"处理。
    // 这不是错误 —— ensureAppDirs 会补建，而补建之前也不该报错。
    return [];
  }
}

/**
 * 读一个插件目录里的清单。
 *
 * **不抛异常**：发现阶段的任何失败都变成返回值上的一条说明。一个坏掉的插件
 * 不该让整次扫描失败 —— 用户需要看到的是"这一个为什么加载不了"，
 * 而不是"插件列表整个打不开"。
 */
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

/** `<dataDir>/plugins/installed/` 下的全部插件 */
async function discoverInstalled(dataDir: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(pluginsDir(dataDir), "installed");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({ ...plugin, source: "user" as const }));
}

/**
 * `<appPath>/resources/plugins/` 下的内置插件。
 *
 * 与内置技能同款：**随包分发、只读、不拷贝到数据目录**，所以升级应用时整包替换
 * 就完成了更新，不存在"用户改过的旧副本"需要迁移。
 *
 * ⚠️ 打包配置必须包含 `resources/**` 才会生效（`electron-builder.yml` 的 `files:`
 * 与 `asarUnpack` 都已覆盖）。漏了的症状是「开发模式一切正常、打包后内置插件为 0」——
 * 与内置技能那个坑是同一个。
 */
async function discoverBuiltin(appPath: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(appPath, "resources", "plugins");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({ ...plugin, source: "builtin" as const, removable: false }));
}

/**
 * 开发插件的目录清单文件。
 *
 * 单独一份 JSON 而不是塞进 settings：它是"开发期的临时挂载点"，与用户配置
 * 混在一起会让"重置设置"顺手把开发插件也清掉。
 */
export const DEV_PLUGINS_FILE = "dev.json";

/** 读开发插件目录清单；文件不存在或坏掉都返回空数组（不是错误） */
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

/**
 * 开发插件：直接引用本地目录，**不拷贝文件**。
 *
 * 为什么单列一档（而不是也当成 installed）：它在三件事上行为不同 ——
 * 不进 `installed/`、卸载不删文件、**改完要手动重载**。
 * 混在一起会让"卸载"这个词对两种插件意味着两件事。
 *
 * ⚠️ **没有文件监视**：方案 §4.10 计划的 300ms 防抖 watcher 尚未实现，
 * 改完插件目录里的文件要在插件管理里点「重载」才生效。
 * 这里曾经写着"带文件监视（保存即热重载）"，而全仓没有任何 watcher ——
 * 那种注释比没有注释更糟：作者和读代码的模型都会以为有一个不存在的行为。
 */
async function discoverDev(dataDir: string): Promise<DiscoveredPlugin[]> {
  const dirs = await readDevPluginDirs(dataDir);
  const found = await Promise.all(
    dirs.map(async (dir) => {
      // 目录必须在：清单写着但目录被删了，也是"这一个加载不了"，不是扫描失败
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

/**
 * 项目级插件：`<工作目录>/.oint/plugins/<名字>/`。
 *
 * ## 为什么要有它（这是"对话直接创建插件"的落点）
 *
 * 模型能写的地方**只有会话工作目录之内**（`sessionAllowedRoots` 的围栏）。
 * 所以"让 AI 帮你写一个插件"要成立，就必须有一个**在工作目录里**的插件目录 ——
 * 这正是它。与 `.oint/skills`、`.oint/prompts`、`.oint/subagents` 同一套约定，
 * 不多发明一层。
 *
 * ## 为什么 removable: false
 *
 * 这里的文件**是用户（或模型替他写的）源码**，不是宿主装进来的东西。
 * 「卸载」在别处意味着"宿主删掉它拷进来的副本"，而在这里它会是"删掉你项目里的文件" ——
 * 同一句话在两个地方指两件事。所以界面把「卸载」换成「打开所在目录」，
 * 要删就用户自己去删。
 *
 * ## 工作目录从哪来
 *
 * 由渲染层在会话切换时通过 `plugins:setWorkspace` 告诉宿主，与
 * `resolveWorkingDir` 是同一个口径（当前会话的 cwd）。不给就跳过这一层 ——
 * **没有工作目录时"猜一个"比"没有"更糟**：那会让 A 项目的插件出现在 B 项目的列表里。
 */
async function discoverProject(workspaceDir: string): Promise<DiscoveredPlugin[]> {
  const parent = path.join(workspaceDir, ".oint", "plugins");
  const names = await listSubdirs(parent);
  const found = await Promise.all(names.map((name) => readPluginManifest(path.join(parent, name))));
  return found.map((plugin) => ({
    ...plugin,
    source: "dev" as const,
    removable: false,
  }));
}

/**
 * 扫描全部来源。
 *
 * 顺序：内置 → **项目** → 用户 → 开发。
 *
 * 前两项不是优先级，只是**展示顺序**（与设置里「系统 / 用户」两个页签的归属一致）；
 * 真正决定同名插件谁胜出的是"谁先被扫到"（见 registry 的 id 撞车处理）。
 * 项目排在用户之前：**同一个插件在项目和全局各有一份时，"这个项目的这一份"是更具体的选择。**
 *
 * `workspaceDir` 缺省时**跳过项目层**（理由见 discoverProject）。
 */
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

/** 插件数据目录名（给 registry / 协议处理器复用，避免两处各写一份归一规则） */
export { pluginDirName };
