// 插件贡献物的**目录快照**：把「哪些插件的哪些子目录要参与资源解析」算一次，
// 供 resources.ts 的三个解析函数与 sessionAllowedRoots 同步读取。
//
// 路径形状与贡献物计数在 `contributions-paths.ts`（那个文件不 import registry，
// 于是依赖是一条直线，见它的文件头）。
//
// ## 为什么是模块级快照，而不是给每个解析函数加一个参数
//
// 方案 §3.6 查过：`resolveSkillDirs` / `resolvePromptTemplateDirs` /
// `resolveSubagentDirs` **各有四个消费者**（设置面板列表、运行时装配、
// `sessionAllowedRoots`、单测）。给它们各加一个 `pluginDirs` 参数意味着
// 四处都要自己从注册表算一遍 —— 而"四处各算一遍"正是这个仓库反复吃亏的形态。
//
// 所以：**算一次放在这里，解析函数同步读它**。代价是那三个解析函数不再是纯函数
//（它们的 purity 早就被 `dataDir()` 破坏了 —— 那个也读环境变量）。
// 需要纯行为的地方（单测）可以显式传 `[]` 绕过快照，见 resources.ts 的参数说明。
//
// ## 谁负责刷新
//
// 三处，缺任何一处都会让贡献物"看起来时有时无"：
//  1. **启动时**（main/index.ts）—— 不刷的话，用户打开插件面板之前启动的会话
//     拿不到任何插件技能；
//  2. 插件列表 `reload()` 之后；
//  3. 启用 / 停用之后。
//
// 后两处都在 ipc/plugins.ts 里，因为那是唯一会改注册表状态的地方。

import path from "node:path";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import {
  contributionDirsOf,
  EMPTY_CONTRIBUTION_DIRS,
  type PluginContributionDirs,
  readMcpServers,
} from "./contributions-paths";
import { buildPluginMcpServers, type PluginMcpIssue, type PluginMcpServer } from "./plugin-mcp";
import { getPluginProcessHost } from "./process-host";
import { getPluginRegistry, type PluginRegistry } from "./registry";

export {
  contributionDirsOf,
  countPluginContributions,
  listPluginContributions,
  type PluginContributionDirs,
  readMcpServers,
  summariseContributions,
} from "./contributions-paths";

let snapshot: PluginContributionDirs = EMPTY_CONTRIBUTION_DIRS;

/** 当前快照。**同步读** —— 解析函数在装配热路径上，不能 await。 */
export function pluginContributionDirs(): PluginContributionDirs {
  return snapshot;
}

/**
 * 已启用插件贡献的 MCP server（**已转成宿主配置**）。
 *
 * 与目录快照同一次重算、同一个理由：调用方（mcp-servers.ts）在装配路径上，不能 await。
 * 返回的是 `McpServerConfig[]` 而不是 `PluginMcpServer[]` —— 运行时只关心配置，
 * 而"来自哪个插件"是面板要的信息（面板走 `resolveMcpServerEntries` 的 source 字段）。
 */
export function pluginMcpServerConfigs(): McpServerConfig[] {
  return mcpServers.map((server) => server.config);
}

/** 最近一次重算时，插件 mcp.json 里没能装载的条目（面板与诊断用） */
export function pluginMcpIssues(): PluginMcpIssue[] {
  return [...mcpIssues];
}

/** 已启用插件贡献的 MCP server（带来源信息，面板用） */
export function pluginMcpServers(): PluginMcpServer[] {
  return mcpServers.map((server) => ({ ...server }));
}

let mcpServers: PluginMcpServer[] = [];
let mcpIssues: PluginMcpIssue[] = [];

/**
 * 从注册表重算快照。
 *
 * `registry` 可以显式注入：生产路径永远走进程内单例（`getPluginRegistry`），
 * 而**单例的 options 只在首次调用时生效** —— 所以单测里每次换一个临时数据目录时，
 * 必须自己 `createPluginRegistry` 并从这里传进来，否则会一直读到第一个测试的表。
 */
export async function refreshPluginContributions(
  options: { appPath?: string; registry?: PluginRegistry } = {},
): Promise<void> {
  const registry = options.registry ?? getPluginRegistry(options);
  if (!registry.loaded) await registry.reload();
  const sources = registry.enabledSources();
  snapshot = merge(sources.map((source) => gatedDirs(source.dir, source.manifest.permissions)));

  /*
    MCP 与目录快照**同一次重算**。
    分成两次算的话，用户启用一个带 mcp.json 的插件之后，目录立刻生效而 MCP
    要等下一次刷新 —— 那种"一半生效"的状态最难查，因为它看起来像插件本身有问题。
  */
  const results = await Promise.all(
    sources.map(async (source) => {
      const dirs = contributionDirsOf(source.dir);
      return buildPluginMcpServers(source.manifest, await readMcpServers(dirs.mcpFiles[0]));
    }),
  );
  mcpServers = results.flatMap((result) => result.servers);
  mcpIssues = results.flatMap((result) => result.issues);

  /*
    插件进程与贡献面**同一次刷新**。
    分开刷的话会出现"技能生效了但工具还没有"这种半生效状态，
    而那种状态看起来像插件本身坏了。
  */
  await getPluginProcessHost().sync(sources);
}

/**
 * 按清单权限筛过的贡献目录。
 *
 * ## 这一步补的是一个真缺口
 *
 * `contributionDirsOf` 只看**目录存不存在**，不看清单写了什么 —— 于是
 * `skills.contribute` / `prompts.contribute` / `subagents.contribute`
 * 这三项权限**是装饰性的**：一个插件不申请它们也能贡献技能。
 *
 * 那违反了这个仓库反复强调的同一条纪律：**清单里写的权限要有对应的执行点**
 *（`net.domains` 那条、`shell.exec` 那条都是这么做的）。一个"申请了也不影响什么、
 * 不申请也能用"的权限，会让用户在权限卡上读到一个不存在的约束。
 *
 * ## 没申请就**整块不贡献**（而不是"贡献了但记一条诊断"）
 *
 * 与 MCP 那边"没申请权限的 server 不装载"完全一致：作者会在**插件详情**里看到
 * 自己的技能一个都没生效，而权限清单里没有对应的项 —— 那条线索足够指向原因。
 */
function gatedDirs(pluginDir: string, permissions: readonly string[]): PluginContributionDirs {
  const dirs = contributionDirsOf(pluginDir);
  const granted = new Set(permissions);
  return {
    skills: granted.has("skills.contribute") ? dirs.skills : [],
    prompts: granted.has("prompts.contribute") ? dirs.prompts : [],
    subagents: granted.has("subagents.contribute") ? dirs.subagents : [],
    // MCP 的权限在 plugin-mcp.ts 里按 server 逐个判（本地与远端是两项能力），这里不重复
    mcpFiles: dirs.mcpFiles,
  };
}

/** 把多个插件的贡献面拍平成一份；顺序即插件顺序（注册表的顺序：内置 → 用户 → 开发） */
function merge(parts: PluginContributionDirs[]): PluginContributionDirs {
  return {
    skills: parts.flatMap((part) => part.skills),
    prompts: parts.flatMap((part) => part.prompts),
    subagents: parts.flatMap((part) => part.subagents),
    mcpFiles: parts.flatMap((part) => part.mcpFiles),
  };
}

/**
 * 清空快照。
 *
 * 只给测试用 —— 生产路径让它是"重算"，而不是"清空"：一个空快照意味着
 * **已启用插件的技能全部消失**，而那是最难查的一类症状。
 */
/**
 * 这个目录是不是**插件贡献的**。
 *
 * 设置面板（技能 / 魔法提示 / 子智能体）据此把它排除掉：那些资源**归插件管**，
 * 不归用户管 —— 用户没法在设置里编辑或删除它们（改了也会被下一次插件同步覆盖），
 * 于是"显示出来"只会制造"这里能管它"的错觉。
 *
 * 而**模型照样能读到**：那一侧走 `resolveSkillDirs` 的完整清单，不经过这个判断。
 * "藏起来"只发生在设置面板这一个消费方。
 */
export function isPluginContributionDir(dir: string): boolean {
  const target = path.resolve(dir).toLowerCase();
  const dirs = pluginContributionDirs();
  return [...dirs.skills, ...dirs.prompts, ...dirs.subagents].some(
    (candidate) => path.resolve(candidate).toLowerCase() === target,
  );
}

export function resetPluginContributionsForTest(): void {
  snapshot = EMPTY_CONTRIBUTION_DIRS;
}
