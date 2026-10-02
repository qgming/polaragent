import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginsDir } from "@/main/app/paths";
import { createPluginRegistry } from "./registry";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "oint-plugin-registry-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function write(dir: string, metadata: unknown) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify(metadata));
}
const metadata = (name: string, oint: Record<string, unknown> = {}) => ({
  name,
  version: "1.0.0",
  oint: { permissions: [], ...oint },
});
const registry = () => createPluginRegistry({ dataDir: root, appPath: root, warn: () => {} });

describe("package discovery and persisted enablement", () => {
  it("enables bundled packages, leaves installed code disabled, and persists an explicit choice", async () => {
    await write(path.join(root, "resources/plugins/builtin"), metadata("oint-builtin"));
    await write(path.join(pluginsDir(root), "installed/custom"), {
      ...metadata("custom"),
      chord: { facets: { agent: "./agent.ts" } },
    });
    const first = registry();
    await first.reload();
    expect(first.find("oint-builtin")?.enabled).toBe(true);
    expect(first.find("custom")).toMatchObject({ enabled: false, hasCode: true });
    await first.setEnabled("custom", true);
    const second = registry();
    await second.reload();
    expect(second.enabledSources().map((source) => source.id)).toEqual(["oint-builtin", "custom"]);
  });
  it("keeps invalid packages visible with diagnostics", async () => {
    await write(
      path.join(pluginsDir(root), "installed/invalid"),
      metadata("invalid", { permissions: ["fs.write"] }),
    );
    const instance = registry();
    expect(await instance.reload()).toMatchObject([{ state: "invalid" }]);
    expect(instance.diagnostics().length).toBeGreaterThan(0);
  });
  it("keeps project sources local to the registry workspace and does not permit deleting them", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await write(path.join(a, ".oint/plugins/a"), metadata("project-a"));
    await write(path.join(b, ".oint/plugins/b"), metadata("project-b"));
    const instance = registry();
    instance.setWorkspaceDir(a);
    expect(await instance.reload()).toMatchObject([{ id: "project-a", removable: false }]);
    instance.setWorkspaceDir(b);
    expect(await instance.reload()).toMatchObject([{ id: "project-b", removable: false }]);
  });
  it("reports duplicate identities and maps the enforced presentation capabilities", async () => {
    await write(
      path.join(root, "resources/plugins/git"),
      metadata("git", {
        permissions: ["shell.exec", "ui.panel"],
        shell: { exec: ["git"] },
        surfaces: [{ id: "git", title: "Git", entry: "./ui/index.html", kind: "panel" }],
      }),
    );
    await write(path.join(pluginsDir(root), "installed/git"), metadata("git"));
    const instance = registry();
    await instance.reload();
    expect(instance.list()).toHaveLength(1);
    expect(instance.diagnostics()[0]?.event).toBe("duplicate.id");
    expect(instance.find("git")?.permissions).toContainEqual({
      id: "shell.exec",
      scope: "git",
      risk: "high",
    });
    expect(instance.find("git")?.surfaces[0]?.url).toContain("oint-plugin:");
  });
});
