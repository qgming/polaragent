import type { McpServerConfig, McpToolConfig } from "./types";
import { checkMcpInstall } from "./client";

export function createEmptyMcpTool(): McpToolConfig {
  return {
    id: "",
    name: "",
    description: "",
    type: "mcp",
    origin: "custom",
    category: "custom",
    icon: "Plug",
    server: {
      transport: "stdio",
      command: "npx",
      args: ["-y", ""],
      env: {},
      headers: {},
      url: "",
    },
    installCheck: { status: "unknown" },
  };
}

export function uniqueMcpToolId(baseId: string, existingIds: Set<string>): string {
  const clean =
    baseId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "mcp-tool";
  let id = clean;
  let suffix = 1;
  while (existingIds.has(id)) {
    id = `${clean}-${suffix++}`;
  }
  return id;
}

export function cloneMcpServer(server: McpServerConfig): McpServerConfig {
  return {
    transport: server.transport,
    command: server.command ?? "",
    args: [...(server.args ?? [])],
    env: { ...(server.env ?? {}) },
    url: server.url ?? "",
    headers: { ...(server.headers ?? {}) },
  };
}

export function cloneMcpDiscoveredTools(tool: McpToolConfig): McpToolConfig["discoveredTools"] {
  return (tool.discoveredTools ?? []).map((item) => ({
    ...item,
    inputSchema: item.inputSchema ? { ...item.inputSchema } : undefined,
  }));
}

export function cloneMcpDisabledToolNames(tool: McpToolConfig): string[] | undefined {
  return tool.disabledToolNames ? [...tool.disabledToolNames] : undefined;
}

export function allMcpRemoteToolNames(tool: McpToolConfig): string[] {
  return (tool.discoveredTools ?? []).map((item) => item.name).sort();
}

export async function detectMcpTool(tool: McpToolConfig): Promise<McpToolConfig> {
  const result = await checkMcpInstall(tool.server);
  return {
    ...tool,
    discoveredTools: result.tools,
    installCheck: {
      status: result.status,
      checkedAt: result.checkedAt,
      message: result.message,
      toolCount: result.toolCount,
    },
  };
}

export async function discoverMcpToolOrThrow(tool: McpToolConfig): Promise<McpToolConfig> {
  const detected = await detectMcpTool(tool);
  if (detected.installCheck?.status !== "installed") {
    throw new Error(detected.installCheck?.message || `MCP server「${tool.name}」检测失败。`);
  }
  if ((detected.discoveredTools ?? []).length === 0) {
    throw new Error(`MCP server「${tool.name}」没有返回任何可用工具。`);
  }
  return detected;
}

export function normalizeMcpToolForSignature(tool: McpToolConfig) {
  return {
    id: tool.id,
    origin: tool.origin,
    server: {
      transport: tool.server.transport,
      command: tool.server.command ?? "",
      args: [...(tool.server.args ?? [])],
      env: sortedRecord(tool.server.env),
      url: tool.server.url ?? "",
      headers: sortedRecord(tool.server.headers),
    },
    disabledToolNames: [...(tool.disabledToolNames ?? [])].sort(),
    discoveredTools: (tool.discoveredTools ?? [])
      .map((item) => ({
        name: item.name,
        title: item.title ?? "",
        description: item.description ?? "",
        inputSchema: item.inputSchema ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    installCheck: {
      status: tool.installCheck?.status ?? "unknown",
      toolCount: tool.installCheck?.toolCount ?? tool.discoveredTools?.length ?? 0,
    },
  };
}

export function mcpServerKey(id: string): string {
  return `mcp:${id}`;
}

export function mcpTransportLabel(transport: McpServerConfig["transport"]): string {
  if (transport === "streamable-http") return "HTTP";
  if (transport === "sse") return "SSE";
  return "stdio";
}

function sortedRecord(record?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record ?? {})
      .filter(([key, value]) => key.trim() !== "" && value.trim() !== "")
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
