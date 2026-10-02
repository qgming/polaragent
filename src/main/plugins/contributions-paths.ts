import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  PluginContributionNames,
  PluginContributionSummary,
  PluginPackage,
} from "@/shared/contracts/plugin";

export interface PluginContributionDirs {
  skills: string[];

  prompts: string[];

  subagents: string[];

  mcpFiles: string[];
}

export const EMPTY_CONTRIBUTION_DIRS: PluginContributionDirs = {
  skills: [],
  prompts: [],
  subagents: [],
  mcpFiles: [],
};

export function contributionDirsOf(pluginDir: string): PluginContributionDirs {
  const candidates = {
    skills: path.join(pluginDir, "skills"),
    prompts: path.join(pluginDir, "prompts"),
    subagents: path.join(pluginDir, "subagents"),
    mcpFiles: path.join(pluginDir, "mcp.json"),
  };
  return {
    skills: existsSync(candidates.skills) ? [candidates.skills] : [],
    prompts: existsSync(candidates.prompts) ? [candidates.prompts] : [],
    subagents: existsSync(candidates.subagents) ? [candidates.subagents] : [],
    mcpFiles: existsSync(candidates.mcpFiles) ? [candidates.mcpFiles] : [],
  };
}

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

export async function countPluginContributions(
  manifest: PluginPackage,
  pluginDir: string,
): Promise<PluginContributionSummary> {
  return summariseContributions(manifest, await listPluginContributions(pluginDir));
}

export function summariseContributions(
  manifest: PluginPackage,
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

async function listMarkdownNames(dir: string | undefined): Promise<string[]> {
  if (dir === undefined) return [];
  const entries = await readdirSafe(dir);
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name.replace(/\.md$/i, ""))
    .sort();
}

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

async function readdirSafe(
  dir: string,
): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
