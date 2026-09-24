/**
 * 插件 `mcp.json` → 宿主配置的适配器，以及三层合并。
 *
 * 两条最值得钉住的：
 *  1. **权限是硬门槛**：ship 了 stdio server 却没申请 `mcp.server.local` 的那一条
 *     不装载，并且要有可读的原因。这是不抄 PI-Desktop「声明了就自动授予」的地方。
 *  2. **server id 由宿主生成且必须唯一**：Agent Plugins 对 mcp.json 的成员名没有
 *     字符集约束，而 Oint 的 id 要求 `^[a-z0-9][a-z0-9_-]*$` 且不含 `__`。
 *     直接用成员名会造出非法 id；只用插件 id 的末段会让两个插件撞车。
 */

import { describe, expect, it } from "vitest";
import { isValidMcpServerId, MCP_NAME_SEPARATOR } from "@/shared/contracts/mcp";
import { AGENT_PLUGINS_SCHEMA_1_0_0, OINT_EXTENSION_NAMESPACE } from "@/shared/contracts/plugin";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { effectiveMcpServerConfigs, resolveMcpServerEntries } from "@/shared/mcp/builtin-servers";
import { validatePluginManifest } from "./manifest";
import { buildPluginMcpServers, pluginServerId } from "./plugin-mcp";

/** 造一份已校验的清单；`permissions` 由各用例给 */
function manifestOf(id: string, permissions: string[]) {
  const result = validatePluginManifest({
    $schema: AGENT_PLUGINS_SCHEMA_1_0_0,
    name: id.replace(/\./g, "-"),
    version: "1.0.0",
    description: "",
    extensions: { [OINT_EXTENSION_NAMESPACE]: { id, apiVersion: "1", permissions } },
  });
  if (!result.ok) throw new Error(result.issues.map((issue) => issue.message).join("; "));
  return result.manifest;
}

describe("pluginServerId", () => {
  it("生成的 id 一定合法（字符集 + 不含双下划线）", () => {
    // 成员名里塞满非法字符：Agent Plugins 不管，Oint 必须管
    for (const member of ["My Server!", "a/b/c", "有中文", "UPPER", "__evil__", "a  b"]) {
      const id = pluginServerId("dev.example.git-lens", member);
      expect(isValidMcpServerId(id), `${member} → ${id}`).toBe(true);
      expect(id).not.toContain(MCP_NAME_SEPARATOR);
    }
  });

  it("**两个插件用同一个成员名不会撞车** —— 这是不用末段做前缀的理由", () => {
    // `dev.acme.tools-a` 与 `dev.acme.tools-b` 的末段完全不同，但只用末段的话
    // `a.git` 与 `b.git` 会撞 —— 而 server id 撞车的后果是
    // 两台 server 的工具混在同一份权限规则 mcp__<id>__* 下
    const one = pluginServerId("a.git", "github");
    const two = pluginServerId("b.git", "github");
    expect(one).not.toBe(two);
  });

  it("超长 id 截断并保留指纹，前缀相同的插件仍不撞车", () => {
    const long = "dev.very-long-vendor-name.another-long-segment.tools";
    const a = pluginServerId(`${long}-alpha`, "some-rather-long-member-name-here");
    const b = pluginServerId(`${long}-beta`, "some-rather-long-member-name-here");
    expect(a.length).toBeLessThanOrEqual(40);
    expect(b.length).toBeLessThanOrEqual(40);
    expect(a).not.toBe(b);
    expect(isValidMcpServerId(a)).toBe(true);
  });

  it("同一对输入总是得到同一个 id（重启后权限规则仍然对得上）", () => {
    expect(pluginServerId("dev.example.x", "github")).toBe(
      pluginServerId("dev.example.x", "github"),
    );
  });
});

describe("buildPluginMcpServers：形状判别", () => {
  it("有 command 是 stdio", () => {
    const manifest = manifestOf("dev.example.x", ["mcp.server.local"]);
    const result = buildPluginMcpServers(manifest, {
      github: { command: "npx", args: ["-y", "server-github"], env: { TOKEN: "t" } },
    });

    expect(result.issues).toEqual([]);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.config.transport).toBe("stdio");
    expect(result.servers[0]?.config.command).toBe("npx");
    expect(result.servers[0]?.config.args).toEqual(["-y", "server-github"]);
    expect(result.servers[0]?.config.env).toEqual({ TOKEN: "t" });
  });

  it("有 url 是 http", () => {
    const manifest = manifestOf("dev.example.x", ["mcp.server.remote"]);
    const result = buildPluginMcpServers(manifest, {
      remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer x" } },
    });

    expect(result.issues).toEqual([]);
    expect(result.servers[0]?.config.transport).toBe("http");
    expect(result.servers[0]?.config.url).toBe("https://mcp.example.com/mcp");
    expect(result.servers[0]?.config.headers).toEqual({ Authorization: "Bearer x" });
  });

  it("两者都没有 → 报错，不装载", () => {
    const result = buildPluginMcpServers(manifestOf("dev.example.x", ["mcp.server.local"]), {
      broken: { description: "只写了说明" },
    });
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.message).toContain("command");
  });

  it("**两者都有 → 报错**（猜错的后果是跑了本地的却没连上期望的远端）", () => {
    const result = buildPluginMcpServers(
      manifestOf("dev.example.x", ["mcp.server.local", "mcp.server.remote"]),
      { both: { command: "npx", url: "https://example.com" } },
    );
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.message).toContain("不能同时");
  });

  it("成员不是对象 → 报错", () => {
    const result = buildPluginMcpServers(manifestOf("dev.example.x", ["mcp.server.local"]), {
      bad: "npx server",
    });
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.message).toContain("对象");
  });
});

describe("**权限是硬门槛，不是提示**", () => {
  it("stdio server 没申请 mcp.server.local → 不装载 + 可读原因", () => {
    // 这正是「不抄 PI-Desktop 的自动授予」的落点：它的权限校验对未声明的能力是跳过，
    // 于是"我没给这个权限"与"我给了但它没生效"在界面上长得一样
    const result = buildPluginMcpServers(manifestOf("dev.example.x", []), {
      github: { command: "npx" },
    });
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.message).toContain("mcp.server.local");
    expect(result.issues[0]?.memberName).toBe("github");
  });

  it("**只有 local 权限挡不住远端 server**（两种传输是两项独立能力）", () => {
    const result = buildPluginMcpServers(manifestOf("dev.example.x", ["mcp.server.local"]), {
      remote: { url: "https://example.com" },
    });
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.message).toContain("mcp.server.remote");
  });

  it("有权限的那几条照常装载，没权限的那几条只影响自己", () => {
    const result = buildPluginMcpServers(manifestOf("dev.example.x", ["mcp.server.local"]), {
      good: { command: "npx" },
      bad: { url: "https://example.com" },
    });
    expect(result.servers.map((server) => server.memberName)).toEqual(["good"]);
    expect(result.issues.map((issue) => issue.memberName)).toEqual(["bad"]);
  });
});

describe("展示信息", () => {
  it("名字带上插件名 —— 面板里同时有系统预设、插件、用户配置", () => {
    const manifest = manifestOf("dev.example.git-lens", ["mcp.server.local"]);
    const result = buildPluginMcpServers(manifest, { github: { command: "npx" } });
    // 一个光秃秃的 "github" 看不出是谁给的
    expect(result.servers[0]?.config.name).toContain("git-lens");
    expect(result.servers[0]?.config.name).toContain("github");
  });

  it("createdAt 用 0 而不是当前时间（配置是每次启动重算的派生物）", () => {
    const result = buildPluginMcpServers(manifestOf("dev.example.x", ["mcp.server.local"]), {
      a: { command: "npx" },
    });
    // 用 Date.now() 会让"这条是不是新装的"这类判断每次启动都变
    expect(result.servers[0]?.config.createdAt).toBe(0);
  });
});

describe("三层合并", () => {
  /** 与 builtin-servers.test.ts 同款的 Settings 夹具（那里也是这么造的） */
  function settings(patch: Partial<Settings> = {}): Settings {
    return {
      theme: "system",
      language: "zh-CN",
      density: "comfortable",
      chatFont: "",
      chatFontSize: 14,
      services: [],
      defaultModel: null,
      thinkingLevel: "medium",
      permissionMode: "default",
      agentMode: "standard",
      disabledSkillNames: [],
      disabledSubagentNames: [],
      mcpServers: [],
      systemMcpServerEnabled: {},
      webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
      ...patch,
    };
  }

  function pluginConfig() {
    const manifest = manifestOf("dev.example.git-lens", ["mcp.server.local"]);
    const result = buildPluginMcpServers(manifest, { github: { command: "npx" } });
    return result.servers.map((server) => server.config);
  }

  it("插件那一层出现在解析结果里，source 是 plugin", () => {
    const entries = resolveMcpServerEntries(settings(), pluginConfig());
    const entry = entries.find((item) => item.source === "plugin");
    expect(entry?.config.command).toBe("npx");
    expect(entry?.overridden).toBe(false);
  });

  it("**用户配置盖住插件**（与用户覆盖插件技能同一条原则）", () => {
    const plugin = pluginConfig();
    const id = plugin[0]?.id ?? "";
    const entries = resolveMcpServerEntries(
      settings({
        mcpServers: [{ ...(plugin[0] as NonNullable<(typeof plugin)[0]>), command: "user-wins" }],
      }),
      plugin,
    );

    // 插件那一条被标记为"被覆盖"
    expect(
      entries.find((item) => item.source === "plugin" && item.config.id === id)?.overridden,
    ).toBe(true);
    // 运行时只留用户那一份
    const effective = effectiveMcpServerConfigs(
      settings({
        mcpServers: [{ ...(plugin[0] as NonNullable<(typeof plugin)[0]>), command: "user-wins" }],
      }),
      plugin,
    );
    expect(effective.filter((config) => config.id === id)).toHaveLength(1);
    expect(effective.find((config) => config.id === id)?.command).toBe("user-wins");
  });

  it("插件可以盖住系统预设（overridden 标在预设那一条上）", () => {
    // 造一个与某台预设同 id 的插件 server
    const presetId = resolveMcpServerEntries(settings()).find((entry) => entry.source === "system")
      ?.config.id;
    if (presetId === undefined) return; // 预设表为空时跳过（不该发生）

    const entries = resolveMcpServerEntries(settings(), [
      { ...(pluginConfig()[0] as NonNullable<ReturnType<typeof pluginConfig>[0]>), id: presetId },
    ]);
    expect(
      entries.find((item) => item.source === "system" && item.config.id === presetId)?.overridden,
    ).toBe(true);
  });

  it("不传插件 server 时行为与从前完全一致（向后兼容）", () => {
    const withoutPlugin = resolveMcpServerEntries(settings());
    expect(withoutPlugin.every((entry) => entry.source !== "plugin")).toBe(true);
  });
});
