// Oint 配置与状态的适配层；MCP 协议、传输、分页及取消全部由 pi-mcp 处理。
import {
  type LlmContent,
  type McpTransport,
  McpClient as PiMcpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
} from "@earendil-works/pi-mcp";
import type { McpServerConfig } from "@/shared/contracts/mcp";
import { stdioOptions } from "./launch-policy";

export interface McpHandshake {
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
}

export interface McpRemoteTool {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly?: boolean;
}

export interface McpCallResult {
  content: LlmContent[];
  isError: boolean;
}

export interface McpClient {
  diagnostics(): string;
  connect(): Promise<McpHandshake>;
  listTools(signal?: AbortSignal): Promise<McpRemoteTool[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpCallResult>;
  onClosed(listener: (reason: string) => void): void;
  onToolsChanged(listener: () => void): () => void;
  readonly label: string;
  close(): Promise<void>;
}

export interface McpClientOptions {
  config: McpServerConfig;
  warn?: (message: string) => void;
  /** Native transport injection, for offline integration tests. */
  transport?: McpTransport;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const { config } = options;
  const warn = options.warn ?? console.warn;
  const transport =
    options.transport ??
    (config.transport === "http"
      ? new StreamableHttpTransport({ url: config.url, headers: config.headers })
      : new StdioTransport(stdioOptions(config, warn)));
  const client = new PiMcpClient({ name: "oint", version: "0.1.0", requestTimeoutMs: 20_000 });
  let lastError = "";
  let closing: Promise<void> | undefined;
  client.onError((error) => {
    lastError = error.message;
    warn(`[mcp:${config.id}] ${lastError}`);
  });
  return {
    label: config.transport === "http" ? `http:${config.url}` : `stdio:${config.command}`,
    diagnostics() {
      const stderr = transport instanceof StdioTransport ? transport.stderr.trim() : "";
      return stderr === "" ? lastError : `stderr：${stderr.split(/\r?\n/).slice(-20).join(" / ")}`;
    },
    async connect() {
      const result = await client.connect(transport);
      return {
        protocolVersion: result.protocolVersion,
        serverName: result.serverInfo.name,
        serverVersion: result.serverInfo.version,
      };
    },
    async listTools(signal) {
      const listed = await client.listTools({ signal, timeoutMs: 20_000 });
      const unique = new Map<string, McpRemoteTool>();
      for (const tool of listed) {
        if (!tool.name || unique.has(tool.name)) continue;
        unique.set(tool.name, {
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema,
          ...(tool.annotations?.readOnlyHint === undefined
            ? {}
            : { readOnly: tool.annotations.readOnlyHint }),
        });
      }
      return [...unique.values()];
    },
    async callTool(name, args, signal) {
      const result = await client.callTool(name, args, { signal, timeoutMs: 120_000 });
      const content = toLlmContent(result);
      return {
        content:
          content.length === 0
            ? [
                {
                  type: "text",
                  text: result.isError
                    ? "MCP server 未给出错误详情。"
                    : "MCP server 未返回任何内容。",
                },
              ]
            : content,
        isError: result.isError === true,
      };
    },
    onToolsChanged(listener) {
      return client.onNotification("notifications/tools/list_changed", listener);
    },
    onClosed(listener) {
      if (client.connectionState === "closed") listener(lastError || "连接已关闭");
      else client.onClose(() => listener(lastError || "连接已关闭"));
    },
    close() {
      closing ??= client.close();
      return closing;
    },
  };
}
