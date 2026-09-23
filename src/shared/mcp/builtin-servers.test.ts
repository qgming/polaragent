// 系统 MCP 预设的注册表完整性 + 两层合并口径。
//
// 为什么要专门测注册表：预设是**随包分发的静态数据**，没有任何类型检查能拦住
// 「id 里带双下划线」「端点是 http 明文」「悄悄塞了一个需要 API Key 的 header」这类改动，
// 而它们的失败方式全是静默的 —— id 非法会被 reload 直接过滤（面板上看就是「预设不见了」），
// 带鉴权要求的端点则表现为「一直连接失败」，用户只会以为应用坏了。

import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { isValidMcpServerId, qualifyMcpToolName } from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import {
  BUILTIN_MCP_SERVERS,
  builtinMcpConfig,
  effectiveMcpServerConfigs,
  findBuiltinMcpServer,
  isPreTrustedMcpTool,
  isSystemServerEnabled,
  isSystemServerTrusted,
  MCP_PRESET_CATEGORIES,
  resolveMcpServerEntries,
} from "./builtin-servers";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
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
    ...overrides,
  };
}

function makeUserConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "my-server",
    name: "我的 server",
    enabled: true,
    transport: "stdio",
    command: "npx",
    args: ["-y", "some-mcp"],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    createdAt: 1,
    ...overrides,
  };
}

describe("系统 MCP 预设注册表", () => {
  it("id 都合法且互不重复", () => {
    const ids = BUILTIN_MCP_SERVERS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // 非法 id 会被 effectiveMcpServerConfigs / reload 直接丢掉，且**不会有任何报错**
      expect(isValidMcpServerId(id)).toBe(true);
      // 顺带钉住限定名的形状：它同时是权限规则 mcp__<id>__* 的解析依据
      expect(qualifyMcpToolName(id, "tool")).toBe(`mcp__${id}__tool`);
    }
  });

  it("每一条都是零配置的远端 HTTPS 端点：没有命令、没有 env、没有 header", () => {
    for (const preset of BUILTIN_MCP_SERVERS) {
      expect(preset.url.startsWith("https://")).toBe(true);
      const config = builtinMcpConfig(preset, true);
      expect(config.transport).toBe("http");
      // 这三个字段里任何一个非空，都意味着用户得填点什么才能连上 —— 那就不是「零配置」了。
      // 需要 Key 的 server（Hugging Face / GitHub / Sentry 之类）因此一律不进这张表。
      expect(config.command).toBe("");
      expect(config.args).toEqual([]);
      expect(config.env).toEqual({});
      expect(config.headers).toEqual({});
      expect(config.cwd).toBe("");
    }
  });

  it("每一条都有 i18n 说明键，且 id 与 key 一一对应（面板靠它取说明）", () => {
    for (const preset of BUILTIN_MCP_SERVERS) {
      expect(preset.descriptionKey.startsWith("settings.mcpBuiltin.")).toBe(true);
      expect(findBuiltinMcpServer(preset.id)).toBe(preset);
    }
    // 说明键不能重复：两条预设共用一句话，等于其中一条没写
    const keys = BUILTIN_MCP_SERVERS.map((preset) => preset.descriptionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("全部默认开启（上下文预算由聚合策略兜住，不靠少开几个来省）", () => {
    // 这一批是「通用 + 全球 + 实测可用」的集合，所以全部默认开启；
    // 上下文预算由聚合兜住（每台 server 恒定一个工具位），不靠「默认少开几个」来省 ——
    // 关掉的那几个用户根本不会去系统页签里翻。
    const enabled = BUILTIN_MCP_SERVERS.filter((preset) => preset.defaultEnabled).map((p) => p.id);
    expect(enabled).toHaveLength(BUILTIN_MCP_SERVERS.length);
  });

  it("每个领域分组都有预设，且分组名都在白名单里", () => {
    const categories = new Set(BUILTIN_MCP_SERVERS.map((preset) => preset.category));
    for (const category of MCP_PRESET_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
    for (const preset of BUILTIN_MCP_SERVERS) {
      expect(MCP_PRESET_CATEGORIES).toContain(preset.category);
    }
  });

  it("不是预设的 id 查不到（用户配置因此不会被误当成预设）", () => {
    expect(findBuiltinMcpServer("mcp-1234abcd")).toBeUndefined();
  });
});

describe("isSystemServerEnabled", () => {
  it("设置里没选过时跟随预设默认值（全部默认开）", () => {
    const settings = makeSettings();
    const wolfram = findBuiltinMcpServer("wolfram");
    if (wolfram === undefined) throw new Error("预设缺失");
    expect(isSystemServerEnabled(settings, wolfram)).toBe(true);
  });

  it("显式选择优先：可以把某台关掉", () => {
    const settings = makeSettings({ systemMcpServerEnabled: { context7: false } });
    const context7 = findBuiltinMcpServer("context7");
    if (context7 === undefined) throw new Error("预设缺失");
    expect(isSystemServerEnabled(settings, context7)).toBe(false);
  });
});

describe("isSystemServerTrusted", () => {
  it("系统预设一律免审批（没有开关，也不读设置）", () => {
    expect(isSystemServerTrusted("wolfram")).toBe(true);
    expect(isSystemServerTrusted("dynamic-feed")).toBe(true);
  });

  it("用户自己加的 server 不走「系统预设免审批」这条路径", () => {
    expect(isSystemServerTrusted("mcp-1234abcd")).toBe(false);
  });
});

/**
 * 权限门用的判定：这个工具调用要不要跳过审批卡。
 *
 * 写错的方向只有两种，都很糟：系统预设每次弹卡（「查一下维基百科」变成一次点击），
 * 或者把用户自加 server 也一起放行（审批门形同虚设）。所以两头都要钉住。
 */
describe("isPreTrustedMcpTool", () => {
  it("系统预设的聚合工具免审批", () => {
    expect(isPreTrustedMcpTool("mcp__wolfram__call")).toBe(true);
  });

  it("系统预设的内层工具名同样免审批（模型可能直接写限定名）", () => {
    expect(isPreTrustedMcpTool("mcp__wolfram__WolframAlpha")).toBe(true);
  });

  it("用户自加 server 的工具不免审批（仍走规则 / 弹卡）", () => {
    expect(isPreTrustedMcpTool("mcp__mcp-1234abcd__call")).toBe(false);
  });

  it("内置工具与非法名字一律返回 false（免得误伤别的工具）", () => {
    expect(isPreTrustedMcpTool("bash")).toBe(false);
    expect(isPreTrustedMcpTool("mcp_tools")).toBe(false);
    expect(isPreTrustedMcpTool("mcp__wolfram")).toBe(false);
  });
});

describe("resolveMcpServerEntries", () => {
  it("系统在前（注册表顺序）、用户在后（设置文件顺序），并各自标出来源", () => {
    const entries = resolveMcpServerEntries(
      makeSettings({ mcpServers: [makeUserConfig({ id: "b" }), makeUserConfig({ id: "a" })] }),
    );

    expect(entries.map((entry) => entry.config.id)).toEqual([
      ...BUILTIN_MCP_SERVERS.map((preset) => preset.id),
      "b",
      "a",
    ]);
    expect(entries.map((entry) => entry.source)).toEqual([
      ...BUILTIN_MCP_SERVERS.map(() => "system"),
      "user",
      "user",
    ]);
  });

  it("同 id 时两边都标 overridden：系统预设说明「没生效」，用户配置说明「你在替代预设」", () => {
    const entries = resolveMcpServerEntries(
      makeSettings({ mcpServers: [makeUserConfig({ id: "context7" })] }),
    );

    const system = entries.find(
      (entry) => entry.source === "system" && entry.config.id === "context7",
    );
    const user = entries.find((entry) => entry.source === "user" && entry.config.id === "context7");
    expect(system?.overridden).toBe(true);
    expect(user?.overridden).toBe(true);
    // 其它预设不受影响
    expect(entries.find((entry) => entry.config.id === "deepwiki")?.overridden).toBe(false);
  });

  it("系统预设的 enabled 来自设置里的显式选择", () => {
    const entries = resolveMcpServerEntries(
      makeSettings({ systemMcpServerEnabled: { context7: false } }),
    );
    const byId = new Map(entries.map((entry) => [entry.config.id, entry.config]));
    expect(byId.get("context7")?.enabled).toBe(false);
    // 没被显式关掉的照常开启
    expect(byId.get("deepwiki")?.enabled).toBe(true);
  });
});

describe("effectiveMcpServerConfigs", () => {
  it("默认全部启用：预设在前、用户配置在后，停用的用户配置被丢掉", () => {
    const configs = effectiveMcpServerConfigs(
      makeSettings({
        mcpServers: [makeUserConfig({ id: "a" }), makeUserConfig({ id: "b", enabled: false })],
      }),
    );

    expect(configs.map((config) => config.id)).toEqual([
      ...BUILTIN_MCP_SERVERS.map((preset) => preset.id),
      "a",
    ]);
  });

  it("同 id 用户配置胜出：列表里不会出现两份同 id 的配置", () => {
    const configs = effectiveMcpServerConfigs(
      makeSettings({
        mcpServers: [makeUserConfig({ id: "context7", url: "https://mine.example/mcp" })],
      }),
    );

    expect(configs.filter((config) => config.id === "context7")).toHaveLength(1);
    expect(configs.find((config) => config.id === "context7")?.url).toBe(
      "https://mine.example/mcp",
    );
  });

  it("用户把同 id 配置停用后，系统预设不会顶上来", () => {
    const configs = effectiveMcpServerConfigs(
      makeSettings({ mcpServers: [makeUserConfig({ id: "context7", enabled: false })] }),
    );

    expect(configs.map((config) => config.id)).not.toContain("context7");
  });

  it("id 非法的用户配置被丢掉（它会让按 server 批量授权静默失效）", () => {
    const configs = effectiveMcpServerConfigs(
      makeSettings({ mcpServers: [makeUserConfig({ id: "bad__id" })] }),
    );

    expect(configs.map((config) => config.id)).not.toContain("bad__id");
  });

  it("全部停用时返回空数组（不是抛错、也不是回落成默认）", () => {
    const configs = effectiveMcpServerConfigs(
      makeSettings({
        systemMcpServerEnabled: Object.fromEntries(
          BUILTIN_MCP_SERVERS.map((preset) => [preset.id, false]),
        ),
      }),
    );

    expect(configs).toEqual([]);
  });
});

describe("builtinMcpConfig", () => {
  it("把预设转成运行时配置：http 传输 + 空 stdio 字段 + createdAt 固定为 0", () => {
    const preset = BUILTIN_MCP_SERVERS[0];
    if (preset === undefined) throw new Error("预设缺失");
    const config = builtinMcpConfig(preset, false);

    expect(config).toMatchObject({
      id: preset.id,
      name: preset.name,
      enabled: false,
      transport: "http",
      url: preset.url,
      command: "",
      createdAt: 0,
    });
  });
});
