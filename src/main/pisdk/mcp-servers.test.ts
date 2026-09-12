import { describe, expect, it } from "vitest";
import type { McpCallResult, McpClient, McpHandshake, McpRemoteTool } from "@/main/mcp/client";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import type { Settings } from "@/shared/contracts/settings";
import { createMcpServers } from "./mcp-servers";

function makeConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "mcp-a",
    name: "A",
    enabled: true,
    transport: "stdio",
    command: "noop",
    args: [],
    env: {},
    cwd: "",
    url: "",
    headers: {},
    createdAt: 1,
    ...overrides,
  };
}

function makeSettings(mcpServers: McpServerConfig[]): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    defaultWorkingDir: null,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    skillDirs: [],
    disabledSkillNames: [],
    skillsEnabled: true,
    promptTemplateDirs: [],
    mcpServers,
  };
}

const READ_FILE: McpRemoteTool = {
  name: "read_file",
  description: "读文件",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

interface FakeClient extends McpClient {
  readonly config: McpServerConfig;
}

/** 可控假客户端：connect 要么成功（带给定工具表）要么按 fail 抛错 */
function createFakeClient(options: {
  config: McpServerConfig;
  log: string[];
  tools?: McpRemoteTool[];
  fail?: string;
}): FakeClient {
  const closedListeners = new Set<(reason: string) => void>();
  return {
    config: options.config,
    label: `fake:${options.config.id}`,
    diagnostics: () => (options.fail === undefined ? "" : "stderr：boom"),
    async connect(): Promise<McpHandshake> {
      options.log.push(`connect:${options.config.id}`);
      if (options.fail !== undefined) throw new Error(options.fail);
      return {
        protocolVersion: "2025-06-18",
        serverName: `${options.config.id}-server`,
        serverVersion: "1.0.0",
      };
    },
    async listTools(): Promise<McpRemoteTool[]> {
      return options.tools ?? [];
    },
    async callTool(name: string): Promise<McpCallResult> {
      options.log.push(`call:${options.config.id}:${name}`);
      return { text: `ok:${name}`, isError: false };
    },
    onClosed(listener) {
      closedListeners.add(listener);
    },
    async close() {
      options.log.push(`close:${options.config.id}`);
      for (const listener of [...closedListeners]) listener("已主动关闭");
    },
  };
}

/** 组装被测对象：设置可随时替换，客户端按配置建 */
function setup(initial: McpServerConfig[], overrides: Partial<Record<string, { fail?: string }>> = {}) {
  const log: string[] = [];
  let current = makeSettings(initial);
  const servers = createMcpServers({
    getSettings: async () => current,
    warn: () => undefined,
    createClient: (config) =>
      createFakeClient({
        config,
        log,
        tools: [READ_FILE],
        ...(overrides[config.id]?.fail === undefined ? {} : { fail: overrides[config.id]?.fail }),
      }),
  });
  return {
    log,
    servers,
    setServers: (next: McpServerConfig[]) => {
      current = makeSettings(next);
    },
  };
}

describe("createMcpServers", () => {
  it("reload：只连接已启用的 server，工具名带 mcp__<id>__ 前缀", async () => {
    const config = makeConfig();
    const disabled = makeConfig({ id: "mcp-b", enabled: false, createdAt: 2 });
    const { log, servers } = setup([config, disabled]);

    const views = await servers.reload();

    expect(log).toEqual(["connect:mcp-a"]);
    expect(servers.tools().map((tool) => tool.name)).toEqual(["mcp__mcp-a__read_file"]);
    expect(views).toHaveLength(2);
    expect(views[0]?.state.status).toBe("ready");
    expect(views[0]?.state.serverName).toBe("mcp-a-server");
    expect(views[1]?.state).toEqual({ status: "idle", tools: [] });
  });

  it("reload：配置没变时不重连（幂等）", async () => {
    const { log, servers } = setup([makeConfig()]);

    await servers.reload();
    await servers.reload();

    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });

  it("reload：并发调用不会给同一个 server 叠两条连接", async () => {
    const { log, servers } = setup([makeConfig()]);

    await Promise.all([servers.reload(), servers.reload()]);

    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });

  it("reload：连接参数变了要重连（名字变了不用）", async () => {
    const { log, servers, setServers } = setup([makeConfig()]);

    await servers.reload();
    setServers([makeConfig({ name: "改了个名字" })]);
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);

    setServers([makeConfig({ args: ["--stdio"] })]);
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(2);
  });

  it("reload：server 被停用或删除时断开连接并撤下工具", async () => {
    const { log, servers, setServers } = setup([makeConfig()]);

    await servers.reload();
    setServers([makeConfig({ enabled: false })]);
    const views = await servers.reload();

    expect(log).toContain("close:mcp-a");
    expect(servers.tools()).toEqual([]);
    expect(views[0]?.state.status).toBe("idle");

    setServers([]);
    await servers.reload();
    expect(servers.tools()).toEqual([]);
  });

  it("连接失败：状态记成 error 并带诊断，下一次 reload 会重试", async () => {
    const { log, servers } = setup([makeConfig()], { "mcp-a": { fail: "握手失败" } });

    const views = await servers.reload();

    expect(views[0]?.state.status).toBe("error");
    expect(views[0]?.state.error).toContain("握手失败");
    expect(views[0]?.state.error).toContain("stderr：boom");
    expect(servers.tools()).toEqual([]);

    // 失败不能把「正在连接」标记留下来，否则永远不再重试
    await servers.reload();
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(2);
  });

  it("subscribe：工具集合变化时收到通知", async () => {
    const { servers } = setup([makeConfig()]);
    let notified = 0;
    const unsubscribe = servers.subscribe(() => {
      notified += 1;
    });

    await servers.reload();
    expect(notified).toBeGreaterThan(0);

    unsubscribe();
    const before = notified;
    await servers.reload();
    expect(notified).toBe(before);
  });

  it("callTool：转发给对应连接；未连接时抛错", async () => {
    const { log, servers } = setup([makeConfig()]);

    await expect(servers.callTool("mcp-a", "read_file", {})).rejects.toThrow("未连接");

    await servers.reload();
    await expect(servers.callTool("mcp-a", "read_file", {})).resolves.toEqual({
      text: "ok:read_file",
      isError: false,
    });
    expect(log).toContain("call:mcp-a:read_file");
  });

  it("probe：不写状态、失败也不抛异常", async () => {
    const { servers } = setup([makeConfig()]);

    const ok = await servers.probe(makeConfig({ id: "mcp-draft" }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.tools.map((tool) => tool.qualifiedName)).toEqual([
        "mcp__mcp-draft__read_file",
      ]);
    }

    const bad = await servers.probe(makeConfig({ id: "mcp-X" }));
    expect(bad).toEqual({ ok: false, reason: "服务器 ID 非法：mcp-X" });

    // 试连不该在连接表里留下条目
    // 试连不该在连接表里留下条目：视图里只有设置里那台 mcp-a
    expect((await servers.views()).map((view) => view.config.id)).toEqual(["mcp-a"]);
  });

  it("dispose：断开全部连接，之后 reload 不再连接", async () => {
    const { log, servers } = setup([makeConfig()]);

    await servers.reload();
    await servers.dispose();

    expect(log).toContain("close:mcp-a");
    expect(servers.tools()).toEqual([]);
    await expect(servers.reload()).resolves.toEqual([]);
    expect(log.filter((line) => line === "connect:mcp-a")).toHaveLength(1);
  });
});
