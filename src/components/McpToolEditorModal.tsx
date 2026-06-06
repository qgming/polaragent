import { useEffect, useState } from "react";
import { Braces, ListChecks, Loader2, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
} from "@/components/ui/modal";
import type { McpDiscoveredTool, McpToolConfig, McpTransport } from "@/types/config";

export type McpEditorMode = "create" | "edit" | "install";

const textareaClass =
  "min-h-[360px] w-full resize-y rounded-lg border border-border bg-background px-3 py-3 font-mono text-xs leading-5 outline-none focus:border-ring";

const createPlaceholder = `粘贴 MCP 客户端配置，例如：
{
  "mcpServers": {
    "server-name": {
      "command": "npx",
      "args": ["-y", "your-mcp-package"]
    }
  }
}`;

export function McpToolEditorModal({
  mode,
  onOpenChange,
  onSave,
  open,
  tool,
}: {
  mode: McpEditorMode;
  onOpenChange: (open: boolean) => void;
  onSave: (tool: McpToolConfig) => Promise<void>;
  open: boolean;
  tool: McpToolConfig;
}) {
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setJsonText(mode === "create" ? "" : JSON.stringify(toMcpServersJson(tool), null, 2));
    setError(null);
    setIsSaving(false);
  }, [mode, tool]);

  const submit = async () => {
    try {
      setIsSaving(true);
      await onSave(normalizeMcpJson(jsonText));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setIsSaving(false);
    }
  };

  const title =
    mode === "create" ? "新增 MCP 工具" : mode === "install" ? "配置并安装 MCP" : "编辑 MCP 工具";

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="2xl">
        <ModalHeader>
          <ModalTitle>{title}</ModalTitle>
          <ModalDescription>
            直接粘贴 MCP 客户端配置。支持 mcpServers 下的 stdio、streamable_http 和 sse。
          </ModalDescription>
        </ModalHeader>
        <ModalBody className="space-y-4">
          <div className="rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="text-sm font-semibold">tool.json</span>
              <span className="text-xs text-muted-foreground">
                mcpServers
              </span>
            </div>
              <textarea
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  if (error) setError(null);
                }}
                className={textareaClass}
                placeholder={mode === "create" ? createPlaceholder : undefined}
                spellCheck={false}
              />
          </div>

          <DiscoveredToolsPanel
            tools={tool.discoveredTools ?? []}
            visible={mode === "edit" || Boolean(tool.discoveredTools?.length)}
          />

          {error ? (
            <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}

        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" disabled={isSaving} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={isSaving} onClick={() => void submit()}>
            {isSaving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {isSaving ? "获取工具中" : mode === "install" ? "安装" : "保存"}
          </Button>
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}

function DiscoveredToolsPanel({
  tools,
  visible,
}: {
  tools: McpDiscoveredTool[];
  visible: boolean;
}) {
  if (!visible) return null;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ListChecks className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">已获取工具</span>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {tools.length} 个
        </span>
      </div>

      {tools.length === 0 ? (
        <div className="px-4 py-5 text-sm text-muted-foreground">
          暂未获取到远端工具，保存时会重新连接 MCP server。
        </div>
      ) : (
        <div className="max-h-[320px] overflow-y-auto">
          {tools.map((remoteTool) => (
            <RemoteToolCard key={remoteTool.name} tool={remoteTool} />
          ))}
        </div>
      )}
    </div>
  );
}

function RemoteToolCard({ tool }: { tool: McpDiscoveredTool }) {
  const fields = extractSchemaFields(tool.inputSchema);

  return (
    <div className="grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border px-4 py-3 last:border-b-0">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{tool.title || tool.name}</h3>
          {tool.title && tool.title !== tool.name ? (
            <code className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
              {tool.name}
            </code>
          ) : null}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {tool.description || "暂无描述"}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <Braces className="size-3" />
        {fields.length} 参数
      </div>
    </div>
  );
}

function extractSchemaFields(schema?: Record<string, unknown>) {
  const properties =
    schema?.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = Array.isArray(schema?.required)
    ? new Set(schema.required.filter((item): item is string => typeof item === "string"))
    : new Set<string>();

  return Object.entries(properties).map(([name, raw]) => {
    const field = raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    return {
      name,
      type: typeof field.type === "string" ? field.type : "value",
      required: required.has(name),
    };
  });
}

function normalizeMcpJson(jsonText: string): McpToolConfig {
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
  if (entries.length > 1) {
    throw new Error("当前一次只支持保存一个 MCP server，请保留一个条目。");
  }

  const [id, rawServer] = entries[0];
  if (!id.trim()) throw new Error("mcpServers 的 server 名称不能为空。");

  const server = getObject(rawServer, `mcpServers.${id}`);
  const transport = normalizeTransport(server.type ?? server.transport);
  const displayName = optionalString(server.name) ?? id;
  const description =
    optionalString(server.description) ?? `${displayName} MCP server`;

  const command = optionalString(server.command);
  const url = optionalString(server.url);
  if (transport === "stdio" && !command) {
    throw new Error("stdio MCP 需要填写 server.command。");
  }
  if (transport !== "stdio" && !url) {
    throw new Error("远程 MCP 需要填写 server.url。");
  }

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
      command,
      url,
      args: normalizeStringArray(server.args, `mcpServers.${id}.args`) ?? [],
      env: normalizeStringRecord(server.env, `mcpServers.${id}.env`),
      headers: normalizeStringRecord(server.headers, `mcpServers.${id}.headers`),
    },
  };
}

function toMcpServersJson(tool: McpToolConfig): {
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是 JSON 对象。`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function normalizeTransport(value: unknown): McpTransport {
  if (value == null) return "stdio";
  if (value === "stdio" || value === "sse") {
    return value;
  }
  if (value === "streamable-http" || value === "streamable_http") {
    return "streamable-http";
  }
  throw new Error('server type 必须是 "stdio"、"streamable_http"、"streamable-http" 或 "sse"。');
}

function toExternalTransport(transport: McpTransport): string {
  if (transport === "streamable-http") return "streamable_http";
  return transport;
}

function normalizeStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value == null) return undefined;
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

function normalizeStringRecord(
  value: unknown,
  label: string,
): Record<string, string> {
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
