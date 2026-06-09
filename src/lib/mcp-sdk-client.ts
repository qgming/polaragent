import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ListToolsResult } from "@modelcontextprotocol/sdk/types.js";

import type { McpServerConfig } from "@/lib/mcp";

const CLIENT_INFO = {
  name: "PolarAgent",
  version: "0.1.0",
};

interface CorsProxyResponse {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

export type McpSdkRemoteTool = ListToolsResult["tools"][number];

export async function mcpSdkListTools(
  server: McpServerConfig,
): Promise<McpSdkRemoteTool[]> {
  if (server.transport === "stdio") {
    const tools = await window.polaragent.mcp.stdioListTools(server);
    return tools.map((tool) => ({
      ...tool,
      inputSchema: normalizeInputSchema(tool.inputSchema),
    }));
  }

  return withMcpClient(server, async (client) => {
    const result = await client.listTools();
    return result.tools;
  });
}

export async function mcpSdkCallTool(params: {
  server: McpServerConfig;
  toolName: string;
  arguments?: Record<string, unknown>;
}): Promise<unknown> {
  if (params.server.transport === "stdio") {
    return window.polaragent.mcp.stdioCallTool(params);
  }

  return withMcpClient(params.server, (client) => {
    return client.callTool({
      name: params.toolName,
      arguments: params.arguments ?? {},
    });
  });
}

function normalizeInputSchema(inputSchema?: Record<string, unknown>): McpSdkRemoteTool["inputSchema"] {
  if (inputSchema && inputSchema.type === "object") {
    return inputSchema as McpSdkRemoteTool["inputSchema"];
  }
  return { type: "object", properties: {} };
}

async function withMcpClient<T>(
  server: McpServerConfig,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  if (server.transport === "stdio") {
    throw new Error("stdio MCP 应由 Electron 主进程代理调用。");
  }

  const url = server.url?.trim();
  if (!url) {
    throw new Error("MCP server 缺少 URL。");
  }

  const client = new Client(CLIENT_INFO, { capabilities: {} });
  const headers = cleanHeaders(server.headers);
  const proxyFetch = createCorsProxyFetch(server.transport);

  const transport =
    server.transport === "sse"
      ? new SSEClientTransport(new URL(url), {
          requestInit: { headers },
          eventSourceInit: { fetch: proxyFetch },
          fetch: proxyFetch,
        })
      : new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers },
          fetch: proxyFetch,
        });

  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
  }
}

function cleanHeaders(headers?: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([key, value]) => key.trim() !== "" && value.trim() !== "",
    ),
  );
}

function createCorsProxyFetch(transport: McpServerConfig["transport"]): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = request?.url ?? input.toString();
    const headers = mergeHeaders(request?.headers, init?.headers);
    const method = init?.method ?? request?.method ?? "GET";

    if (
      transport === "streamable-http" &&
      method.toUpperCase() === "GET" &&
      headers.accept?.includes("text/event-stream")
    ) {
      return new Response("", { status: 405, statusText: "Method Not Allowed" });
    }

    const body = await serializeBody(init?.body);

    const response = await window.polaragent.network.corsFetch({
      url,
      method,
      headers,
      body,
    }) as CorsProxyResponse;

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

function mergeHeaders(
  requestHeaders?: Headers,
  initHeaders?: HeadersInit,
): Record<string, string> {
  const headers = new Headers(requestHeaders);
  if (initHeaders) {
    new Headers(initHeaders).forEach((value, key) => {
      headers.set(key, value);
    });
  }
  return Object.fromEntries(headers.entries());
}

async function serializeBody(body?: BodyInit | null): Promise<string | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof Blob) return body.text();
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(body);
  }
  throw new Error("MCP 代理暂不支持当前请求体类型。");
}
