/**
 * 插件贡献面（T0）：技能 / 提示 / 子智能体的目录快照。
 *
 * 这一组里最重要的一条是**「允许根与解析目录必须同步」**。
 * 方案 §3.6 特意把它点出来，因为本仓已经踩过一次同款坑（内置技能那次）：
 * `resolveSkillDirs` 里加了目录、`sessionAllowedRoots` 忘了加 ——
 * 症状是**「目录存在、插件也启用了、却一个技能都没有」**，而 diagnostics 里
 * 只有一行 `list_failed`。所以下面把两者写在同一个用例里断言，
 * 让"只改了一处"必然变红。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginsDir } from "@/main/app/paths";
import {
  resolvePromptTemplateDirs,
  resolveSkillDirs,
  resolveSubagentDirs,
} from "@/main/pisdk/resources";
import { sessionAllowedRoots } from "@/main/pisdk/runtime";
import { AGENT_PLUGINS_SCHEMA_1_0_0, OINT_EXTENSION_NAMESPACE } from "@/shared/contracts/plugin";
import {
  contributionDirsOf,
  refreshPluginContributions,
  resetPluginContributionsForTest,
} from "./contributions";
import { createPluginRegistry, type PluginRegistry } from "./registry";

/**
 * 每个用例自建注册表。
 *
 * **不能用 `getPluginRegistry()`**：那是进程内单例，而它的 options 只在首次调用时生效
 * —— 每个用例都换了临时数据目录，用单例会一直读到第一个用例的那张表
 *（症状就是「找不到插件：xxx」）。所以测试从 `refreshPluginContributions` 的
 * `registry` 参数显式注入。
 */
function freshRegistry(): PluginRegistry {
  return createPluginRegistry({ dataDir, appPath, warn: () => {} });
}

let dataDir: string;
let appPath: string;
let originalHome: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "oint-contrib-"));
  appPath = await mkdtemp(path.join(tmpdir(), "oint-contrib-app-"));
  originalHome = process.env.OINT_HOME;
  // resolveSkillDirs / sessionAllowedRoots 都走 dataDir()，而它读这个环境变量
  process.env.OINT_HOME = dataDir;
  resetPluginContributionsForTest();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.OINT_HOME;
  else process.env.OINT_HOME = originalHome;
  resetPluginContributionsForTest();
  await rm(dataDir, { recursive: true, force: true });
  await rm(appPath, { recursive: true, force: true });
});

function manifest(id: string): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGINS_SCHEMA_1_0_0,
    name: id.replace(/\./g, "-"),
    version: "1.0.0",
    description: "",
    extensions: {
      [OINT_EXTENSION_NAMESPACE]: {
        id,
        apiVersion: "1",
        /*
          三项 contribute 权限默认给上：**贡献目录按权限筛**（见 contributions.ts 的
          gatedDirs），不声明的话技能/提示/子智能体会被整块丢掉。
          这组用例测的是"目录怎么解析、优先级怎么排"，不是权限门 ——
          权限门本身由 builtin.test.ts 的「贡献 X 就要申请 X」那条盯着。
        */
        permissions: ["skills.contribute", "prompts.contribute", "subagents.contribute"],
      },
    },
  };
}

/**
 * 造一个已安装插件，并按需建贡献目录。
 *
 * 来源用 `installed`（用户装进来的），于是**默认是停用的** ——
 * 每个用例都要显式启用，这正好让"停用就不贡献"这件事在每个用例里都被走过一遍。
 */
async function writePlugin(
  dirName: string,
  id: string,
  dirs: { skills?: boolean; prompts?: boolean; subagents?: boolean; mcp?: boolean } = {},
): Promise<string> {
  const dir = path.join(pluginsDir(dataDir), "installed", dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest(id)), "utf8");
  if (dirs.skills) await mkdir(path.join(dir, "skills"), { recursive: true });
  if (dirs.prompts)
    await mkdir(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts"), { recursive: true });
  if (dirs.subagents)
    await mkdir(path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents"), { recursive: true });
  if (dirs.mcp) await writeFile(path.join(dir, "mcp.json"), "{}", "utf8");
  return dir;
}

/** 启用一个插件；走的是 IPC 层同一条路径（reload → setEnabled → 重算） */
async function enable(id: string): Promise<PluginRegistry> {
  const registry = freshRegistry();
  await registry.reload();
  await registry.setEnabled(id, true);
  await refreshPluginContributions({ appPath, registry });
  return registry;
}

describe("contributionDirsOf", () => {
  it("**只返回真实存在的目录** —— 否则每个不贡献技能的插件都会刷一条 list_failed", async () => {
    const dir = await writePlugin("bare", "dev.example.bare");
    expect(contributionDirsOf(dir)).toEqual({
      skills: [],
      prompts: [],
      subagents: [],
      mcpFiles: [],
    });
  });

  it("存在的目录按标准位置（skills / mcp.json）与私有目录（dev.oint/*）取", async () => {
    const dir = await writePlugin("full", "dev.example.full", {
      skills: true,
      prompts: true,
      subagents: true,
      mcp: true,
    });
    expect(contributionDirsOf(dir)).toEqual({
      skills: [path.join(dir, "skills")],
      prompts: [path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts")],
      subagents: [path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents")],
      mcpFiles: [path.join(dir, "mcp.json")],
    });
  });
});

describe("快照只收已启用的插件", () => {
  it("没启用时贡献面是空的", async () => {
    await writePlugin("git-lens", "dev.example.git-lens", { skills: true });
    const registry = freshRegistry();
    await registry.reload();
    await refreshPluginContributions({ appPath, registry });

    expect(resolveSkillDirs(undefined, appPath)).not.toContain(
      path.join(pluginsDir(dataDir), "installed", "git-lens", "skills"),
    );
  });

  it("启用之后立刻出现在三个解析函数里", async () => {
    const dir = await writePlugin("git-lens", "dev.example.git-lens", {
      skills: true,
      prompts: true,
      subagents: true,
    });
    await enable("dev.example.git-lens");

    expect(resolveSkillDirs(undefined, appPath)).toContain(path.join(dir, "skills"));
    expect(resolvePromptTemplateDirs(undefined, appPath)).toContain(
      path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts"),
    );
    expect(resolveSubagentDirs(undefined)).toContain(
      path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents"),
    );
  });

  it("清单不合法的插件即使被启用也不贡献（它没有可用的目录语义）", async () => {
    const dir = path.join(pluginsDir(dataDir), "installed", "bad");
    await mkdir(path.join(dir, "skills"), { recursive: true });
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({ ...manifest("dev.example.bad"), name: "Bad_Name" }),
      "utf8",
    );

    const registry = freshRegistry();
    await registry.reload();
    // setEnabled 对 invalid 的行仍然会记启用（用户点了），但贡献面不该收它
    await registry.setEnabled("bad", true);
    await refreshPluginContributions({ appPath, registry });

    expect(resolveSkillDirs(undefined, appPath)).not.toContain(path.join(dir, "skills"));
  });
});

describe("优先级顺序", () => {
  it("用户 → 项目 → 插件 → 内置（用户永远能覆盖插件）", async () => {
    const dir = await writePlugin("git-lens", "dev.example.git-lens", { skills: true });
    await enable("dev.example.git-lens");

    const dirs = resolveSkillDirs("D:\\work\\demo", appPath);
    /*
      前两项要用**模板串里的正斜杠**比（`` `${dataDir()}/skills` ``），不是 path.join 的
      反斜杠 —— 那是 resources.ts 的既有写法（内核两种分隔符都认）。
      用 path.join 比会在 Windows 上因为 `\` 与 `/` 的差别找不到下标，
      而失败信息（expected -1 to be >= 0）看起来像"顺序错了"。
    */
    const user = dirs.indexOf(`${dataDir}/skills`);
    const project = dirs.indexOf("D:\\work\\demo/.oint/skills");
    const plugin = dirs.indexOf(path.join(dir, "skills"));
    const builtin = dirs.findIndex((entry) =>
      entry.includes(`${path.sep}resources${path.sep}skills`),
    );

    expect(user).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThan(user);
    expect(plugin).toBeGreaterThan(project);
    expect(builtin).toBeGreaterThan(plugin);
  });
});

describe("**允许根必须与解析目录同步**（方案 §3.6 点名的坑）", () => {
  it("插件贡献的目录既在 resolveSkillDirs 里，也在 sessionAllowedRoots 里", async () => {
    /*
      只改一处时的症状：目录存在、插件启用了、却 0 个技能。
      内核的 listDir 会被路径守卫拒绝，而 diagnostics 里只有一行 list_failed ——
      很容易被当成「插件没带技能」而不是「守卫挡住了」。

      所以这两条断言写在同一个用例里：**只改一处必然变红**。
    */
    const dir = await writePlugin("git-lens", "dev.example.git-lens", {
      skills: true,
      prompts: true,
      subagents: true,
    });
    await enable("dev.example.git-lens");

    const resolved = [
      ...resolveSkillDirs(undefined, appPath),
      ...resolvePromptTemplateDirs(undefined, appPath),
      ...resolveSubagentDirs(undefined),
    ];
    const allowed = sessionAllowedRoots("D:\\work\\demo", appPath);

    for (const contribution of [
      path.join(dir, "skills"),
      path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts"),
      path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents"),
    ]) {
      expect(resolved, `${contribution} 该参与解析`).toContain(contribution);
      expect(allowed, `${contribution} 该在允许根里（否则内核 listDir 会被守卫拒绝）`).toContain(
        contribution,
      );
    }
  });

  it("停用之后两处一起消失（不会留下单边的允许根）", async () => {
    const dir = await writePlugin("git-lens", "dev.example.git-lens", { skills: true });
    await enable("dev.example.git-lens");

    const registry = await enable("dev.example.git-lens");
    await registry.setEnabled("dev.example.git-lens", false);
    await refreshPluginContributions({ appPath, registry });

    expect(resolveSkillDirs(undefined, appPath)).not.toContain(path.join(dir, "skills"));
    expect(sessionAllowedRoots("D:\\work\\demo", appPath)).not.toContain(path.join(dir, "skills"));
  });
});

describe("显式传参可以绕过快照（单测要纯行为时用）", () => {
  it("传空数组时解析函数完全不看快照", async () => {
    const dir = await writePlugin("git-lens", "dev.example.git-lens", { skills: true });
    await enable("dev.example.git-lens");

    // 默认读快照
    expect(resolveSkillDirs(undefined, appPath)).toContain(path.join(dir, "skills"));
    // 显式传 [] 就是旧行为
    expect(resolveSkillDirs(undefined, appPath, [])).not.toContain(path.join(dir, "skills"));
  });
});

describe("贡献物计数（面板上「贡献了什么」那一行）", () => {
  /** 造一个技能：内核要的是 `<skills>/<name>/SKILL.md` */
  async function writeSkill(pluginDir: string, name: string): Promise<void> {
    const dir = path.join(pluginDir, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `# ${name}\n`, "utf8");
  }

  it("**数字与装配口径一致**：只数真的会被装载的东西", async () => {
    const dir = await writePlugin("full", "dev.example.full", {
      prompts: true,
      subagents: true,
      mcp: true,
    });
    await writeSkill(dir, "review");
    await writeSkill(dir, "translate");
    // 一个没有 SKILL.md 的目录**不算技能** —— 内核扫到它也不会产出任何东西
    await mkdir(path.join(dir, "skills", "not-a-skill"), { recursive: true });
    await writeFile(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts", "a.md"), "x", "utf8");
    await writeFile(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts", "b.md"), "x", "utf8");
    // 非 .md 不算（pi 的 loadPromptTemplates 只认 .md）
    await writeFile(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts", "c.txt"), "x", "utf8");
    await writeFile(
      path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents", "worker.md"),
      "x",
      "utf8",
    );
    await writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { one: {}, two: {} } }),
      "utf8",
    );

    const { countPluginContributions } = await import("./contributions");
    const { validatePluginManifest } = await import("./manifest");
    const { readFile: read } = await import("node:fs/promises");
    const parsed = validatePluginManifest(
      JSON.parse(await read(path.join(dir, "plugin.json"), "utf8")) as unknown,
    );
    if (!parsed.ok) throw new Error("夹具清单应该合法");

    expect(await countPluginContributions(parsed.manifest, dir)).toEqual({
      panels: 0,
      modals: 0,
      windows: 0,
      commands: 0,
      skills: 2,
      prompts: 2,
      subagents: 1,
      mcpServers: 2,
      tools: 0,
    });
  });

  /**
   * **名字与计数出自同一份实现**（`counts = names.length`）。
   *
   * 这条是界面的前提：详情页上"技能 2"下面必须正好列出两个名字。
   * 两路各算一遍的话，某次改动（比如技能判定要不要认 SKILL.md）之后
   * 数字与名字会各说各话，而那种不一致在界面上看起来只是"数字有点怪"。
   *
   * 名字的排序也钉住：列表由 readdir 决定顺序，不排的话每次进详情页顺序都可能变
   *（同一个插件看起来像变过东西）。
   */
  it("名字清单：按同一口径列出，计数即名字个数，且顺序稳定", async () => {
    const dir = await writePlugin("named", "dev.example.named", {
      prompts: true,
      subagents: true,
      mcp: true,
    });
    await writeSkill(dir, "translate");
    await writeSkill(dir, "review"); // 故意乱序造：断言里要求排好序
    await writeFile(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts", "zeta.md"), "x", "utf8");
    await writeFile(path.join(dir, OINT_EXTENSION_NAMESPACE, "prompts", "alpha.md"), "x", "utf8");
    await writeFile(
      path.join(dir, OINT_EXTENSION_NAMESPACE, "subagents", "worker.md"),
      "x",
      "utf8",
    );
    await writeFile(
      path.join(dir, "mcp.json"),
      JSON.stringify({ mcpServers: { two: {}, one: {} } }),
      "utf8",
    );

    const { countPluginContributions, listPluginContributions } = await import("./contributions");
    const { validatePluginManifest } = await import("./manifest");
    const { readFile: read } = await import("node:fs/promises");
    const parsed = validatePluginManifest(
      JSON.parse(await read(path.join(dir, "plugin.json"), "utf8")) as unknown,
    );
    if (!parsed.ok) throw new Error("夹具清单应该合法");

    const names = await listPluginContributions(dir);
    expect(names).toEqual({
      // 技能名 = 目录名；prompt / subagent 名 = 去掉 .md 的文件名；MCP 名 = mcpServers 的键
      skills: ["review", "translate"],
      prompts: ["alpha", "zeta"],
      subagents: ["worker"],
      mcpServers: ["one", "two"],
    });

    const counts = await countPluginContributions(parsed.manifest, dir);
    expect(counts.skills).toBe(names.skills.length);
    expect(counts.prompts).toBe(names.prompts.length);
    expect(counts.subagents).toBe(names.subagents.length);
    expect(counts.mcpServers).toBe(names.mcpServers.length);
  });

  it("界面计入 panels / windows（按 kind 分开）", async () => {
    const dir = path.join(pluginsDir(dataDir), "installed", "ui");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify({
        ...manifest("dev.example.ui"),
        extensions: {
          [OINT_EXTENSION_NAMESPACE]: {
            id: "dev.example.ui",
            apiVersion: "1",
            permissions: ["ui.panel", "ui.window"],
            surfaces: [
              { id: "a", kind: "panel", title: "A", entry: "./a.html" },
              { id: "b", kind: "panel", title: "B", entry: "./b.html" },
              { id: "pet", kind: "window", title: "宠物", entry: "./pet.html" },
            ],
          },
        },
      }),
      "utf8",
    );

    const { countPluginContributions } = await import("./contributions");
    const { validatePluginManifest } = await import("./manifest");
    const { readFile: read } = await import("node:fs/promises");
    const parsed = validatePluginManifest(
      JSON.parse(await read(path.join(dir, "plugin.json"), "utf8")) as unknown,
    );
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join("; "));

    const counts = await countPluginContributions(parsed.manifest, dir);
    expect(counts.panels).toBe(2);
    expect(counts.windows).toBe(1);
  });

  it("一件都不贡献的插件得到全 0，而不是抛错", async () => {
    const dir = await writePlugin("bare", "dev.example.bare");
    const { countPluginContributions } = await import("./contributions");
    const { validatePluginManifest } = await import("./manifest");
    const { readFile: read } = await import("node:fs/promises");
    const parsed = validatePluginManifest(
      JSON.parse(await read(path.join(dir, "plugin.json"), "utf8")) as unknown,
    );
    if (!parsed.ok) throw new Error("夹具清单应该合法");

    expect(await countPluginContributions(parsed.manifest, dir)).toEqual({
      panels: 0,
      modals: 0,
      windows: 0,
      commands: 0,
      skills: 0,
      prompts: 0,
      subagents: 0,
      mcpServers: 0,
      tools: 0,
    });
  });

  it("注册表把这些数字带进 PluginView（面板读的就是它）", async () => {
    const dir = await writePlugin("git-lens", "dev.example.git-lens", { skills: true });
    await writeSkill(dir, "status");
    await writeSkill(dir, "diff");

    const registry = freshRegistry();
    const views = await registry.reload();
    expect(views[0]?.contributions.skills).toBe(2);
  });

  it("mcp.json 坏掉时计 0，而不是让整次扫描失败", async () => {
    const dir = await writePlugin("bad-mcp", "dev.example.bad-mcp", { mcp: true });
    await writeFile(path.join(dir, "mcp.json"), "{ 坏掉的 JSON", "utf8");

    const registry = freshRegistry();
    const views = await registry.reload();
    expect(views[0]?.contributions.mcpServers).toBe(0);
    // 插件本身照常可用 —— 一个坏的 mcp.json 不该让整个插件变成 invalid
    expect(views[0]?.state).toBe("disabled");
  });
});
