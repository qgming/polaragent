// MCP 通道：设置面板的读状态 / 试连 / 重载出口。
//
// 连接本身由 pisdk/mcp-servers.ts 的共享单例维护（与运行时同源），
// 这里只做转发与错误包装 —— 面板看到的「已连接 / 失败原因」就是运行时实际在用的状态。

import { getMcpServers } from "@/main/pisdk/mcp-servers";
import { IPC } from "@/shared/contracts/ipc";
import type { McpProbeResult, McpServerConfig, McpServerView } from "@/shared/contracts/mcp";
import { handle } from "./handler";

export function registerMcpIpc(): void {
  handle(
    IPC.mcp.list,
    "读取 MCP 服务器",
    async (): Promise<McpServerView[]> => getMcpServers().views(),
  );
  handle(
    IPC.mcp.reload,
    "重载 MCP 服务器",
    async (): Promise<McpServerView[]> => getMcpServers().reload(),
  );
  // 试连用草稿配置，不写设置、不占用已有连接；失败原因原样回给面板
  handle(
    IPC.mcp.probe,
    "测试 MCP 服务器",
    async (config: McpServerConfig): Promise<McpProbeResult> => getMcpServers().probe(config),
  );
}
