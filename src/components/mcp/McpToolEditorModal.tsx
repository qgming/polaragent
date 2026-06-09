import { useEffect, useState } from "react";
import { Braces, ListChecks, Loader2 } from "lucide-react";

import {
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalTitle,
} from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { parseMcpServersJson, parseMcpServersJsonList, toMcpServersJson } from "@/lib/mcp";
import type { McpDiscoveredTool, McpToolConfig } from "@/lib/mcp";

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
  onSaveMany,
  open,
  tool,
}: {
  mode: McpEditorMode;
  onOpenChange: (open: boolean) => void;
  onSave: (tool: McpToolConfig) => Promise<void>;
  onSaveMany?: (tools: McpToolConfig[]) => Promise<void>;
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
      if (mode === "create" && onSaveMany) {
        const tools = parseMcpServersJsonList(jsonText);
        if (tools.length > 1) {
          await onSaveMany(tools);
        } else {
          await onSave(tools[0]);
        }
      } else {
        await onSave(parseMcpServersJson(jsonText));
      }
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
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">{title}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Braces className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            · 直接粘贴 MCP 客户端配置
          </span>
        </header>

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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            取消
          </Button>
          <Button variant="default" onClick={() => void submit()} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                获取工具中
              </>
            ) : (
              mode === "install" ? "安装" : "保存"
            )}
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
