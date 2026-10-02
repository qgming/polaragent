import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validatePluginManifest } from "./manifest";

const BUILTIN_ROOT = path.resolve(import.meta.dirname, "../../../resources/plugins");

async function pluginDirs(): Promise<string[]> {
  const entries = await readdir(BUILTIN_ROOT, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

describe("内置插件目录", () => {
  it("**至少有一个内置插件** —— 空的 resources/plugins 会让打包配置的对错无从验证", async () => {
    expect(await pluginDirs()).not.toEqual([]);
  });

  it("每一份清单都合法（内置插件随包分发，用户没法修）", async () => {
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "package.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) {
        throw new Error(
          `${name}/package.json 不合法：\n` +
            result.issues.map((issue) => `  ${issue.path}：${issue.message}`).join("\n"),
        );
      }
      expect(result.warnings, `${name} 有警告`).toEqual([]);
    }
  });

  it("**清单里引用的界面文件真的存在**（路径写错在运行期是「窗口打开是白的」）", async () => {
    for (const name of await pluginDirs()) {
      const dir = path.join(BUILTIN_ROOT, name);
      const raw = await readFile(path.join(dir, "package.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue; // 上一条用例已经报过了

      for (const surface of result.manifest.surfaces) {
        const target = path.join(dir, surface.entry);
        const content = await readFile(target, "utf8").catch(() => undefined);
        expect(
          content,
          `${name} 的界面 ${surface.id} 指向了不存在的文件：${surface.entry}`,
        ).toBeDefined();
      }
    }
  });

  it("内置插件的 id 用 `dev.oint.` 前缀（与用户装进来的第三方插件分得开）", async () => {
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "package.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      expect(result.manifest.id, `${name} 的 id 前缀不对`).toMatch(/^dev\.oint\./);
    }
  });

  it("**声明了 main 的插件必须申请对应的注册权限** —— 否则进程永远起不来", async () => {
    for (const name of await pluginDirs()) {
      const raw = await readFile(path.join(BUILTIN_ROOT, name, "package.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      if (result.manifest.agentFacet === undefined) continue;
      const canRegister =
        result.manifest.permissions.includes("agent.tool.register") ||
        result.manifest.permissions.includes("commands.register");
      expect(canRegister, `${name} 有 main.js 却没申请注册类权限（进程永远不会起）`).toBe(true);
    }
  });

  it("贡献技能 / 提示 / 子智能体的插件必须申请对应权限", async () => {
    for (const name of await pluginDirs()) {
      const dir = path.join(BUILTIN_ROOT, name);
      const raw = await readFile(path.join(dir, "package.json"), "utf8");
      const result = validatePluginManifest(JSON.parse(raw) as unknown);
      if (!result.ok) continue;
      for (const [folder, permission] of [
        ["skills", "skills.contribute"],
        ["prompts", "prompts.contribute"],
        ["subagents", "subagents.contribute"],
      ] as const) {
        const present = await readdir(path.join(dir, folder)).catch(() => undefined);
        if (present === undefined) continue;
        expect(
          result.manifest.permissions.includes(permission),
          `${name} 有 ${folder}/ 却没申请 ${permission}`,
        ).toBe(true);
      }
    }
  });
});
