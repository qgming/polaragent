import type { McpToolConfig, McpTransport } from "./types";

export function parseMcpServersJson(jsonText: string): McpToolConfig {
  const tools = parseMcpServersJsonList(jsonText);
  if (tools.length > 1) {
    throw new Error("当前一次只支持保存一个 MCP server，请保留一个条目。");
  }
  return tools[0];
}

export function parseMcpServersJsonList(jsonText: string): McpToolConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new Error(`JSON 格式错误：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("MCP 工具配置必须是 JSON 对象。");
  }

  const record = parsed as Record<string, unknown>;
  const mcpServers = getObject(record.mcpServers, "mcpServers");
  const entries = Object.entries(mcpServers);
  if (entries.length === 0) {
    throw new Error("mcpServers 至少需要包含一个 server。");
  }

  return entries.map(([id, rawServer]) => parseMcpServerEntry(id, rawServer));
}

function parseMcpServerEntry(id: string, rawServer: unknown): McpToolConfig {
  if (!id.trim()) throw new Error("mcpServers 的 server 名称不能为空。");

  const server = getObject(rawServer, `mcpServers.${id}`);
  const transportObject = isObject(server.transport) ? server.transport : undefined;
  const transportConfig = transportObject ?? server;
  const transport = normalizeTransport(server.type ?? transportObject?.type ?? server.transport);
  const displayName = optionalString(server.name) ?? id;
  const description = optionalString(server.description) ?? `${displayName} MCP server`;

  const command = optionalString(transportConfig.command);
  const url = optionalString(transportConfig.url ?? server.url);
  if (transport === "stdio" && !command) {
    throw new Error("stdio MCP 需要填写 server.command。");
  }
  if (transport !== "stdio" && !url) {
    throw new Error("远程 MCP 需要填写 server.url。");
  }

  const normalizedCommand = transport === "stdio"
    ? normalizeStdioCommand(command ?? "", normalizeStringArray(transportConfig.args, `mcpServers.${id}.args`) ?? [])
    : undefined;

  return {
    id: id.trim(),
    name: displayName,
    description,
    type: "mcp",
    origin: "custom",
    category: optionalString(server.category),
    icon: optionalString(server.icon),
    tags: normalizeStringArray(server.tags, `mcpServers.${id}.tags`),
    source: optionalString(server.source),
    notes: optionalString(server.notes),
    server: {
      transport,
      command: normalizedCommand?.command ?? command,
      url,
      args: normalizedCommand?.args ?? [],
      env: normalizeStringRecord(transportConfig.env, `mcpServers.${id}.env`),
      headers: normalizeStringRecord(transportConfig.headers ?? server.headers, `mcpServers.${id}.headers`),
    },
  };
}

export function toMcpServersJson(tool: McpToolConfig): {
  mcpServers: Record<string, Record<string, unknown>>;
} {
  const server: Record<string, unknown> = {
    type: toExternalTransport(tool.server.transport),
  };

  if (tool.server.transport === "stdio") {
    server.command = tool.server.command ?? "";
    server.args = tool.server.args ?? [];
  } else {
    server.url = tool.server.url ?? "";
  }

  if (tool.server.env && Object.keys(tool.server.env).length > 0) {
    server.env = tool.server.env;
  }
  if (tool.server.headers && Object.keys(tool.server.headers).length > 0) {
    server.headers = tool.server.headers;
  }

  if (tool.name && tool.name !== tool.id) server.name = tool.name;
  if (tool.description) server.description = tool.description;
  if (tool.category) server.category = tool.category;
  if (tool.source) server.source = tool.source;
  if (tool.tags?.length) server.tags = tool.tags;
  if (tool.notes) server.notes = tool.notes;

  return {
    mcpServers: {
      [tool.id || "my-mcp-server"]: server,
    },
  };
}

function getObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTransport(value: unknown): McpTransport {
  if (value == null) return "stdio";
  if (typeof value !== "string") {
    throw new Error('server type 必须是字符串："stdio"、"streamable_http"、"streamable-http"、"streamablehttp"、"http" 或 "sse"。');
  }
  // 归一化：转小写并去掉所有非字母数字字符，兼容 streamablehttp / streamable-http /
  // streamable_http / streamableHttp / http 等多种常见写法。
  const canonical = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (canonical === "stdio") return "stdio";
  if (canonical === "sse") return "sse";
  if (canonical === "streamablehttp" || canonical === "http" || canonical === "streamhttp") {
    return "streamable-http";
  }
  throw new Error('server type 必须是 "stdio"、"streamable_http"、"streamable-http"、"streamablehttp"、"http" 或 "sse"。');
}

function toExternalTransport(transport: McpTransport): string {
  if (transport === "streamable-http") return "streamable_http";
  return transport;
}

function normalizeStringArray(value: unknown, label: string): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是字符串数组。`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new Error(`${label} 必须是字符串数组。`);
    }
    return item;
  });
}

function normalizeStringRecord(value: unknown, label: string): Record<string, string> {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }

  return Object.entries(value as Record<string, unknown>).reduce(
    (acc, [key, entryValue]) => {
      acc[key] = entryValue == null ? "" : String(entryValue);
      return acc;
    },
    {} as Record<string, string>,
  );
}

const SPLITTABLE_STDIO_LAUNCHERS = new Set([
  "npx",
  "pnpx",
  "bunx",
  "uvx",
  "uv",
  "node",
  "python",
  "python3",
  "deno",
]);

function normalizeStdioCommand(command: string, args: string[]): { command: string; args: string[] } {
  const trimmed = command.trim();
  if (!trimmed || args.length > 0) return { command, args };

  const firstToken = trimmed.split(/\s+/)[0]?.replace(/^['"]|['"]$/g, "");
  if (!firstToken || !SPLITTABLE_STDIO_LAUNCHERS.has(firstToken) || !/\s/.test(trimmed)) {
    return { command, args };
  }

  const tokens = shellSplit(trimmed);
  if (tokens.length < 2) return { command, args };
  return { command: tokens[0], args: tokens.slice(1) };
}

function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "\\" && quote === '"' && index + 1 < input.length) {
        current += input[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < input.length) {
      current += input[index + 1];
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}
