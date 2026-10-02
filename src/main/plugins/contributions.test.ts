import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allPluginMcpServerConfigs,
  countPluginContributions,
  pluginContributionDirs,
  pluginMcpServerConfigs,
  refreshPluginContributions,
  resetPluginContributionsForTest,
} from "./contributions";
import { validatePluginManifest } from "./manifest";
import { createPluginRegistry } from "./registry";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-plugin-contributions-"));
  resetPluginContributionsForTest();
});
afterEach(async () => {
  resetPluginContributionsForTest();
  await rm(root, { recursive: true, force: true });
});
async function project(cwd: string, id: string, permissions: string[]) {
  const dir = path.join(cwd, ".oint/plugins", id);
  const metadata = { name: id, version: "1.0.0", oint: { permissions } };
  await mkdir(path.join(dir, "skills/review"), { recursive: true });
  await mkdir(path.join(dir, "prompts"), { recursive: true });
  await mkdir(path.join(dir, "subagents"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(metadata));
  await writeFile(path.join(dir, "skills/review/SKILL.md"), "# review");
  await writeFile(path.join(dir, "prompts/review.md"), "review");
  await writeFile(path.join(dir, "subagents/reviewer.md"), "reviewer");
  await writeFile(
    path.join(dir, "mcp.json"),
    JSON.stringify({ mcpServers: { remote: { url: "https://example.com/mcp", type: "http" } } }),
  );
  const registry = createPluginRegistry({ dataDir: root });
  registry.setWorkspaceDir(cwd);
  await registry.reload();
  await registry.setEnabled(id, true);
  await refreshPluginContributions({ registry });
  return { dir, metadata, registry };
}
describe("workspace-scoped plugin contributions", () => {
  it("keeps project resource and MCP visibility independent of UI workspace changes", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    const first = await project(a, "project-a", ["skills.contribute", "mcp.server.remote"]);
    const second = await project(b, "project-b", ["prompts.contribute", "mcp.server.remote"]);
    expect(pluginContributionDirs(a).skills).toEqual([path.join(first.dir, "skills")]);
    expect(pluginContributionDirs(a).prompts).toEqual([]);
    expect(pluginContributionDirs(b).skills).toEqual([]);
    expect(pluginContributionDirs(b).prompts).toEqual([path.join(second.dir, "prompts")]);
    expect(pluginContributionDirs().skills).toEqual([]);
    expect(pluginMcpServerConfigs(a)).toHaveLength(1);
    expect(pluginMcpServerConfigs(b)).toHaveLength(1);
    expect(pluginMcpServerConfigs(a)[0]?.id).not.toBe(pluginMcpServerConfigs(b)[0]?.id);
    expect(allPluginMcpServerConfigs()).toHaveLength(2);
  });
  it("removes contributions immediately on disable and counts the package's actual resources", async () => {
    const cwd = path.join(root, "a");
    const { dir, metadata, registry } = await project(cwd, "project-a", ["skills.contribute"]);
    const parsed = validatePluginManifest(metadata);
    if (!parsed.ok) throw new Error("fixture");
    expect(await countPluginContributions(parsed.manifest, dir)).toMatchObject({
      skills: 1,
      prompts: 1,
      subagents: 1,
    });
    await registry.setEnabled("project-a", false);
    await refreshPluginContributions({ registry });
    expect(pluginContributionDirs(cwd).skills).toEqual([]);
  });
});
