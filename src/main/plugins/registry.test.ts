/**
 * 插件发现与注册表。
 *
 * 全部在真实临时目录上跑（node:fs/promises 造夹具）—— 这一层的价值就在
 * 「扫目录 + 读文件 + 合并状态」，那些只有真实文件系统才能验。
 *
 * 三条贯穿全篇的口径：
 *  1. **坏插件也要出现在列表里**（`invalid` + 可读原因），而不是静默消失 ——
 *     否则用户装了一个坏包，界面上什么都没多，他只会以为安装失败了；
 *  2. **内置默认开、用户装进来的默认关**（外部代码要用户点头）；
 *  3. **id 撞车时不静默丢弃**，记一条明确的诊断。
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginsDir } from "@/main/app/paths";
import { AGENT_PLUGINS_SCHEMA_1_0_0, OINT_EXTENSION_NAMESPACE } from "@/shared/contracts/plugin";
import { createPluginRegistry } from "./registry";

let dataDir: string;
let appPath: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "oint-plugins-"));
  appPath = await mkdtemp(path.join(tmpdir(), "oint-app-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(appPath, { recursive: true, force: true });
});

/** 一份合法清单 */
function manifest(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: AGENT_PLUGINS_SCHEMA_1_0_0,
    name: id.replace(/\./g, "-"),
    version: "1.0.0",
    description: `${id} 的说明`,
    extensions: {
      [OINT_EXTENSION_NAMESPACE]: { id, apiVersion: "1", permissions: [], ...extra },
    },
  };
}

/** 在某个来源下造一个插件目录；返回它的路径 */
async function writePlugin(
  source: "installed" | "builtin" | "dev",
  dirName: string,
  content: unknown,
): Promise<string> {
  const root =
    source === "builtin"
      ? path.join(appPath, "resources", "plugins")
      : source === "installed"
        ? path.join(pluginsDir(dataDir), "installed")
        : dataDir; // dev 的目录由调用方自己造，这里只是给个基准
  const dir = path.join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "plugin.json"),
    typeof content === "string" ? content : JSON.stringify(content, null, 2),
    "utf8",
  );
  return dir;
}

function make(options: { appPath?: string } = {}) {
  return createPluginRegistry({
    dataDir,
    ...(options.appPath === undefined ? {} : { appPath: options.appPath }),
    warn: () => {},
  });
}

describe("扫描三个来源", () => {
  it("什么都没有时返回空列表（不是错误）", async () => {
    const registry = make({ appPath });
    expect(await registry.reload()).toEqual([]);
    expect(registry.loaded).toBe(true);
  });

  it("内置插件被扫到，且**默认启用**", async () => {
    await writePlugin("builtin", "pet", manifest("dev.example.pet"));
    const views = await make({ appPath }).reload();

    expect(views).toHaveLength(1);
    expect(views[0]?.id).toBe("dev.example.pet");
    expect(views[0]?.source).toBe("builtin");
    expect(views[0]?.enabled).toBe(true);
    expect(views[0]?.state).toBe("running");
  });

  it("装进来的插件被扫到，且**默认停用**（外部代码要用户点头）", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    const views = await make({ appPath }).reload();

    expect(views).toHaveLength(1);
    expect(views[0]?.source).toBe("user");
    expect(views[0]?.enabled).toBe(false);
    expect(views[0]?.state).toBe("disabled");
  });

  it("顺序是 内置 → 用户", async () => {
    await writePlugin("installed", "b-user", manifest("dev.example.user"));
    await writePlugin("builtin", "a-builtin", manifest("dev.example.builtin"));
    const views = await make({ appPath }).reload();

    expect(views.map((view) => view.source)).toEqual(["builtin", "user"]);
  });

  it("不给 appPath 就跳过内置层（单测与不关心的调用方）", async () => {
    await writePlugin("builtin", "pet", manifest("dev.example.pet"));
    expect(await make().reload()).toEqual([]);
  });
});

describe("清单的展示映射", () => {
  it("权限带上风险档位与范围", async () => {
    await writePlugin(
      "installed",
      "git-lens",
      manifest("dev.example.git-lens", {
        // fs.read 也要列进权限：声明了 fs 范围却没有对应权限是校验失败，
        // 那正是"一个用不了的权限是笔误"那条规则
        permissions: ["ui.panel", "shell.exec", "fs.read"],
        shell: { exec: ["git"] },
        fs: { read: { root: "workspace", scope: ["src/**"] } },
      }),
    );
    const view = (await make({ appPath }).reload())[0];

    const panel = view?.permissions.find((item) => item.id === "ui.panel");
    expect(panel?.risk).toBe("low");

    const shell = view?.permissions.find((item) => item.id === "shell.exec");
    expect(shell?.risk).toBe("high");
    // **范围永远挨着权限显示** —— 一个孤零零的 shell.exec 会让用户以为它能跑任何命令
    expect(shell?.scope).toBe("git");
  });

  it("fs 权限的范围串带上 root 与 scope", async () => {
    await writePlugin(
      "installed",
      "reader",
      manifest("dev.example.reader", {
        permissions: ["fs.read"],
        fs: { read: { root: "workspace", scope: ["src/**", "docs/**"] } },
      }),
    );
    const view = (await make({ appPath }).reload())[0];
    expect(view?.permissions[0]?.scope).toBe("workspace/src/**,docs/**");
  });

  /**
   * `hasMain` 是**界面那句信任边界的唯一判据**（方案 §4.11）。
   *
   * 判错任何一侧都有可见后果，而且方向相反：
   * - 带代码的插件漏报 → 用户以为权限表管住了一切，而它其实能直接 require("node:fs")；
   * - 不带代码的插件误报 → 一个只贡献技能的包被描述成"能读写文件、联网"。
   *
   * 所以两侧各钉一条，且**不按 permissions 推断**：`main` 才是事实。
   */
  it("hasMain：清单里有 main 才是 true，没有就是 false", async () => {
    await writePlugin(
      "installed",
      "with-code",
      manifest("dev.example.with-code", {
        permissions: ["agent.tool.register"],
        main: "./main.cjs",
      }),
    );
    await writePlugin(
      "installed",
      "declarative",
      // 声明式插件也可能申请高权限（这里给 ui.panel），但**不跑代码**
      manifest("dev.example.declarative", { permissions: ["ui.panel"] }),
    );

    const views = await make({ appPath }).reload();

    expect(views.find((view) => view.name === "dev-example-with-code")?.hasMain).toBe(true);
    expect(views.find((view) => view.name === "dev-example-declarative")?.hasMain).toBe(false);
  });

  it("界面声明映射成 surfaces（title 取中文那一份）", async () => {
    await writePlugin(
      "installed",
      "git-lens",
      manifest("dev.example.git-lens", {
        permissions: ["ui.panel"],
        surfaces: [
          {
            id: "git",
            kind: "panel",
            title: { en: "Git", "zh-CN": "版本控制" },
            entry: "./ui/git.html",
          },
        ],
      }),
    );
    const view = (await make({ appPath }).reload())[0];
    expect(view?.surfaces).toEqual([
      {
        id: "git",
        kind: "panel",
        title: "版本控制",
        // URL 与分区都由主进程算（一种形状，一个产地 —— 见 PluginSurfaceInfo 的说明）
        url: "oint-plugin://surface/dev.example.git-lens/ui/git.html",
        partition: "persist:oint-plugin-dev-example-git-lens",
      },
    ]);
  });

  it("**每个插件的分区互不相同** —— 共用分区等于共用 localStorage", async () => {
    // 这与"跨插件读到一张图片"不是一个量级：localStorage 里可能是插件缓存的令牌或用户数据
    await writePlugin(
      "installed",
      "a",
      manifest("dev.example.one", {
        permissions: ["ui.panel"],
        surfaces: [{ id: "p", kind: "panel", title: "A", entry: "./a.html" }],
      }),
    );
    await writePlugin(
      "installed",
      "b",
      manifest("dev.example.two", {
        permissions: ["ui.panel"],
        surfaces: [{ id: "p", kind: "panel", title: "B", entry: "./b.html" }],
      }),
    );

    const views = await make({ appPath }).reload();
    const partitions = views.map((item) => item.surfaces[0]?.partition);
    expect(partitions[0]).not.toBe(partitions[1]);
    // 归一之后仍然可读（分区名最终会变成用户数据目录下的一个文件夹名）
    expect(partitions).toContain("persist:oint-plugin-dev-example-one");
  });
});

describe("坏插件也要出现（不能静默消失）", () => {
  it("目录里没有 plugin.json", async () => {
    await mkdir(path.join(pluginsDir(dataDir), "installed", "empty"), { recursive: true });
    const view = (await make({ appPath }).reload())[0];

    expect(view?.state).toBe("invalid");
    expect(view?.error).toContain("plugin.json");
    // id 退回目录名 —— 至少让用户看得出是哪一个目录
    expect(view?.id).toBe("empty");
  });

  it("JSON 坏了与清单不合法是两条不同的说明", async () => {
    await writePlugin("installed", "broken", "{ 这不是 JSON");
    const view = (await make({ appPath }).reload())[0];

    expect(view?.state).toBe("invalid");
    expect(view?.error).toContain("不是合法 JSON");
  });

  it("清单字段不合法时把问题逐条列出来", async () => {
    await writePlugin("installed", "bad", { ...manifest("dev.example.bad"), name: "Bad_Name" });
    const view = (await make({ appPath }).reload())[0];

    expect(view?.state).toBe("invalid");
    expect(view?.error).toContain("name");
  });

  it("**根上未知字段只警告，仍然正常加载**（Agent Plugins 的 MUST）", async () => {
    await writePlugin("installed", "extra", { ...manifest("dev.example.extra"), futureField: 1 });
    const view = (await make({ appPath }).reload())[0];

    expect(view?.state).toBe("disabled"); // 合法、只是默认停用
    expect(view?.error).toContain("futureField");
  });

  it("清单不合法时启用它，state 仍然是 invalid（打开一个坏包不会让它变好）", async () => {
    await writePlugin("installed", "bad", { ...manifest("dev.example.bad"), name: "Bad_Name" });
    const registry = make({ appPath });
    await registry.reload();

    const views = await registry.setEnabled("bad", true);
    expect(views[0]?.enabled).toBe(true);
    expect(views[0]?.state).toBe("invalid");
  });
});

describe("id 撞车", () => {
  it("不静默丢弃：第一个胜出并记一条诊断", async () => {
    await writePlugin("builtin", "a-first", manifest("dev.example.same"));
    await writePlugin("installed", "z-second", manifest("dev.example.same"));

    const registry = make({ appPath });
    const views = await registry.reload();

    expect(views).toHaveLength(1);
    // 来源顺序（内置 → 用户）决定谁胜出
    expect(views[0]?.source).toBe("builtin");

    const diagnostics = registry.diagnostics();
    expect(diagnostics.some((item) => item.event === "duplicate.id")).toBe(true);
    // 诊断里要指出被忽略的是哪一个目录，否则用户无从排查
    expect(diagnostics.find((item) => item.event === "duplicate.id")?.message).toContain(
      "z-second",
    );
  });
});

describe("启停持久化", () => {
  it("启用后落盘，重建注册表仍然启用", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    const first = make({ appPath });
    await first.reload();
    await first.setEnabled("dev.example.git-lens", true);

    // 换一个实例（模拟重启）
    const second = make({ appPath });
    const views = await second.reload();
    expect(views[0]?.enabled).toBe(true);
    expect(views[0]?.state).toBe("running");
  });

  it("停用内置插件也持久化（默认值只影响没有显式选择时）", async () => {
    await writePlugin("builtin", "pet", manifest("dev.example.pet"));
    const first = make({ appPath });
    await first.reload();
    expect((await first.setEnabled("dev.example.pet", false))[0]?.enabled).toBe(false);

    const views = await make({ appPath }).reload();
    expect(views[0]?.enabled).toBe(false);
  });

  it("状态文件是人类可读的 JSON（便于排查与手改）", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    const registry = make({ appPath });
    await registry.reload();
    await registry.setEnabled("dev.example.git-lens", true);

    const raw = await readFile(path.join(pluginsDir(dataDir), "state.json"), "utf8");
    const parsed = JSON.parse(raw) as { version: number; enabled: Record<string, boolean> };
    expect(parsed.version).toBe(1);
    expect(parsed.enabled["dev.example.git-lens"]).toBe(true);
  });

  it("状态文件坏掉时回落默认值，而不是让整次扫描失败", async () => {
    await writePlugin("builtin", "pet", manifest("dev.example.pet"));
    await mkdir(pluginsDir(dataDir), { recursive: true });
    await writeFile(path.join(pluginsDir(dataDir), "state.json"), "{ 坏掉的 JSON", "utf8");

    const views = await make({ appPath }).reload();
    expect(views[0]?.enabled).toBe(true); // 回落到"内置默认开"
  });

  it("对不存在的 id 启停抛错 —— 那不是操作失败，是调用方给错了", async () => {
    const registry = make({ appPath });
    await registry.reload();
    await expect(registry.setEnabled("dev.example.nope", true)).rejects.toThrow(/找不到插件/);
  });

  it("find 能按 id 取到那一行", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    const registry = make({ appPath });
    await registry.reload();

    expect(registry.find("dev.example.git-lens")?.name).toBe("dev-example-git-lens");
    expect(registry.find("dev.example.nope")).toBeUndefined();
  });
});

describe("开发插件", () => {
  it("dev.json 里列的目录被扫到，来源是 dev", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oint-dev-plugin-"));
    await writeFile(
      path.join(dir, "plugin.json"),
      JSON.stringify(manifest("dev.example.work")),
      "utf8",
    );
    await mkdir(pluginsDir(dataDir), { recursive: true });
    await writeFile(path.join(pluginsDir(dataDir), "dev.json"), JSON.stringify([dir]), "utf8");

    const views = await make({ appPath }).reload();
    expect(views).toHaveLength(1);
    expect(views[0]?.source).toBe("dev");
    expect(views[0]?.id).toBe("dev.example.work");

    await rm(dir, { recursive: true, force: true });
  });

  it("dev.json 里指向一个不存在的目录 → 那一个报错，不影响别的", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    await mkdir(pluginsDir(dataDir), { recursive: true });
    await writeFile(
      path.join(pluginsDir(dataDir), "dev.json"),
      JSON.stringify([path.join(dataDir, "gone")]),
      "utf8",
    );

    const views = await make({ appPath }).reload();
    expect(views).toHaveLength(2);
    expect(views.some((view) => view.error?.includes("不存在"))).toBe(true);
  });

  it("dev.json 坏掉时按空清单处理（不是错误）", async () => {
    await writePlugin("installed", "git-lens", manifest("dev.example.git-lens"));
    await mkdir(pluginsDir(dataDir), { recursive: true });
    await writeFile(path.join(pluginsDir(dataDir), "dev.json"), "不是 JSON", "utf8");

    const views = await make({ appPath }).reload();
    expect(views).toHaveLength(1);
  });
});
