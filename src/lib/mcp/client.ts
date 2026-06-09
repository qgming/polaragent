import { mcpSdkCallTool, mcpSdkListTools } from "@/lib/mcp-sdk-client";

import type { McpDiscoveredTool, McpInstallCheck, McpServerConfig } from "./types";

export const listMcpTools = (server: McpServerConfig): Promise<McpDiscoveredTool[]> =>
  mcpSdkListTools(server);

export const callMcpTool = (params: {
  server: McpServerConfig;
  toolName: string;
  arguments?: Record<string, unknown>;
}): Promise<unknown> => mcpSdkCallTool(params);

export async function checkMcpInstall(
  server: McpServerConfig,
): Promise<McpInstallCheck & { tools: McpDiscoveredTool[] }> {
  try {
    const tools = await listMcpTools(server);
    return {
      status: "installed",
      checkedAt: Date.now(),
      message: tools.length > 0 ? `检测成功，发现 ${tools.length} 个工具。` : "检测成功，但未发现可用工具。",
      toolCount: tools.length,
      tools,
    };
  } catch (error) {
    return {
      status: "failed",
      checkedAt: Date.now(),
      message: error instanceof Error ? error.message : String(error),
      toolCount: 0,
      tools: [],
    };
  }
}
