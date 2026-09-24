// 插件贡献面的**路径与计数**：插件目录长什么样、每个贡献面各有多少东西。
//
// ## 为什么单独一个文件（与 contributions.ts 分开）
//
// 因为依赖方向。这个文件**不 import registry**，于是依赖是一条直线：
//
//     contributions.ts（快照）  ─┐
//                                ├─→ contributions-paths.ts
//     registry.ts（扫描）        ─┘
//
// 合成一个文件会形成 `contributions ↔ registry` 的循环。那在实际执行上**能跑**
//（两边都只在函数体里用对方，模块体不碰），但本仓在 panel-registry.ts 里已经把
// ESM 循环的代价写清楚了：**它会在"某个模块体提前访问了还没初始化的 const"时炸**，
// 而那是一个随改动漂移的隐性约束。直线依赖不需要谁记住这件事。

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  OINT_EXTENSION_NAMESPACE,
  type OintPluginManifest,
  type PluginContributionNames,
  type PluginContributionSummary,
} from "@/shared/contracts/plugin";

/**
 * 各贡献面的目录清单。
 *
 * ## 目录位置：一半是标准、一半是 Oint 私有
 *
 * ```
 * my-plugin/
 * ├── plugin.json
 * ├── skills/          ← Agent Plugins 标准的固定位置
 * ├── mcp.json         ← Agent Plugins 标准的固定位置
 * └── dev.oint/        ← Oint 的私有目录
 *     ├── prompts/
 *     └── subagents/
 * ```
 *
 * `prompts` 与 `subagents` 是 Oint 特有的贡献面，标准里没有它们。**放进
 * `dev.oint/` 而不是插件根**，是因为 Agent Plugins §8 对"客户端私有文件"有明确规定：
 * *"Client-specific files MUST be represented under a top-level directory named for
 * that namespace"* —— 那个目录名**恰好等于扩展命名空间**。
 *
 * 这么做有一个直接好处：别的客户端扫到 `dev.oint/` 会**整体忽略**（规范 §8.1 是 MUST），
 * 而不需要认识里面每一个子目录叫什么。
 */
export interface PluginContributionDirs {
  /** `<plugin>/skills` */
  skills: string[];
  /** `<plugin>/dev.oint/prompts` */
  prompts: string[];
  /** `<plugin>/dev.oint/subagents` */
  subagents: string[];
  /** `<plugin>/mcp.json` 的路径（**文件**，不是目录） */
  mcpFiles: string[];
}

export const EMPTY_CONTRIBUTION_DIRS: PluginContributionDirs = {
  skills: [],
  prompts: [],
  subagents: [],
  mcpFiles: [],
};

/**
 * 从一个插件目录算出它的贡献面。**只返回真实存在的那些**。
 *
 * 为什么先 `existsSync` 而不是交给内核的扫描器去报"目录不存在"：
 * 内核的 `loadSkills` 对不存在的目录会产出 `list_failed` 诊断 —— 而一个
 * **压根没打算贡献技能**的插件（大多数）会因此每次都刷一条警告。
 * 过滤掉之后，诊断里剩下的才是真问题。
 */
export function contributionDirsOf(pluginDir: string): PluginContributionDirs {
  const candidates = {
    skills: path.join(pluginDir, "skills"),
    prompts: path.join(pluginDir, OINT_EXTENSION_NAMESPACE, "prompts"),
    subagents: path.join(pluginDir, OINT_EXTENSION_NAMESPACE, "subagents"),
    mcpFiles: path.join(pluginDir, "mcp.json"),
  };
  return {
    skills: existsSync(candidates.skills) ? [candidates.skills] : [],
    prompts: existsSync(candidates.prompts) ? [candidates.prompts] : [],
    subagents: existsSync(candidates.subagents) ? [candidates.subagents] : [],
    mcpFiles: existsSync(candidates.mcpFiles) ? [candidates.mcpFiles] : [],
  };
}

/** 一个插件的贡献物清单（名字）。**不需要清单** —— 它只反映磁盘上有什么 */
export async function listPluginContributions(pluginDir: string): Promise<PluginContributionNames> {
  const dirs = contributionDirsOf(pluginDir);
  const [skills, prompts, subagents, mcp] = await Promise.all([
    listSkillNames(dirs.skills[0]),
    listMarkdownNames(dirs.prompts[0]),
    listMarkdownNames(dirs.subagents[0]),
    readMcpServers(dirs.mcpFiles[0]),
  ]);
  return { skills, prompts, subagents, mcpServers: Object.keys(mcp).sort() };
}

/**
 * 数一个插件贡献了多少东西。
 *
 * ## 为什么要数，而不是只显示"有 / 没有"
 *
 * 插件行上最有用的一个数字是「这个插件到底给我带来了什么」。没有它，用户面对
 * 一个装了却看不见效果的插件只能靠猜 —— 而"装了没效果"正是这个仓库反复踩的形态。
 *
 * ## 只数**会被真正装配**的东西
 *
 * 计数口径必须与装配口径一致，否则数字就是在骗人：
 *  - 技能：`<dir>/skills/<name>/SKILL.md` —— 与内核 `loadSkills` 的规则取交集，
 *    这里按**直接子目录里有没有 SKILL.md** 判；
 *  - 提示：`dev.oint/prompts/*.md` —— **只读直接子级**（pi 的 loadPromptTemplates 不递归）；
 *  - 子智能体：`dev.oint/subagents/*.md`；
 *  - MCP：`mcp.json` 的 `mcpServers` 成员数；
 *  - 界面：清单里的 `surfaces`。
 *
 * `commands` 与 `tools` 恒为 0：它们属于 T1，本期还没有装配路径。
 * **显示 0 而不是省略** —— 省略会让"这个插件没有工具"与"我们没统计工具"长得一样。
 *
 * ⚠️ **计数一律取名字清单的长度**（`listPluginContributions`），不再各实现一遍：
 * 两份实现会让计数与清单漂移，而界面上那个数字是给用户判断"装它值不值"用的。
 */
export async function countPluginContributions(
  manifest: OintPluginManifest,
  pluginDir: string,
): Promise<PluginContributionSummary> {
  return summariseContributions(manifest, await listPluginContributions(pluginDir));
}

/**
 * 由「名字清单」导出「计数摘要」。**纯函数**，不碰磁盘。
 *
 * registry 就是这样用的：它并行扫一次目录拿到名字（每插件一次 IO），
 * 然后在那个串行循环里用这个纯函数导出计数 —— 于是
 * **计数的口径不可能与清单漂移**（同一个来源），也不会为了"数一遍、再列一遍"
 * 扫两遍盘。界面上的"技能 2"与展开的那两个名字因此永远是同一件事。
 *
 * 界面（panels / modals / windows）不走磁盘：它们来自清单里的 `surfaces`，所以在这里从
 * manifest 现算。
 */
export function summariseContributions(
  manifest: OintPluginManifest,
  names: PluginContributionNames,
): PluginContributionSummary {
  return {
    panels: manifest.surfaces.filter((surface) => surface.kind === "panel").length,
    modals: manifest.surfaces.filter((surface) => surface.kind === "modal").length,
    windows: manifest.surfaces.filter((surface) => surface.kind === "window").length,
    commands: 0,
    skills: names.skills.length,
    prompts: names.prompts.length,
    subagents: names.subagents.length,
    mcpServers: names.mcpServers.length,
    tools: 0,
  };
}

/** `<skillsDir>/<name>/SKILL.md` 的技能名 */
async function listSkillNames(skillsDir: string | undefined): Promise<string[]> {
  if (skillsDir === undefined) return [];
  const entries = await readdirSafe(skillsDir);
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) names.push(entry.name);
  }
  return names.sort();
}

/** 目录直接子级里的 `.md` 名字（去掉扩展名，不递归 —— 与 pi 的 loadPromptTemplates 一致） */
async function listMarkdownNames(dir: string | undefined): Promise<string[]> {
  if (dir === undefined) return [];
  const entries = await readdirSafe(dir);
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/i, ""))
    .sort();
}

/**
 * 读一个 `mcp.json` 并取出 `mcpServers` 成员。
 *
 * Agent Plugins 用的是与其他客户端一致的形状（`{ "mcpServers": { "<名字>": {...} } }`）。
 * **任何失败都返回空对象**：这一层只负责"有没有、有几个"，具体某一条配置合不合法
 * 要等 MCP 装配那一半（那一步会逐条校验并报错）。在这里抛错会让整个插件列表打不开 ——
 * 一个坏掉的 `mcp.json` 不该有那个权力。
 */
export async function readMcpServers(file: string | undefined): Promise<Record<string, unknown>> {
  if (file === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return {};
    const servers = (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return {};
    return servers as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** readdir 的容错版：目录不存在或不可读都当空 */
async function readdirSafe(
  dir: string,
): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
