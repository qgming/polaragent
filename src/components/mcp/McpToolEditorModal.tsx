import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("tools");
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
    mode === "create" ? t("editor.titleCreate") : mode === "install" ? t("editor.titleInstall") : t("editor.titleEdit");

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent size="2xl" showCloseButton={true} className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background">
        <ModalTitle className="sr-only">{title}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <Braces className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium">{title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">
            · {t("editor.subtitle")}
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
                placeholder={mode === "create" ? t("editor.placeholder") : undefined}
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
            {t("editor.cancel")}
          </Button>
          <Button variant="default" onClick={() => void submit()} disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t("editor.fetchingTools")}
              </>
            ) : (
              mode === "install" ? t("editor.install") : t("editor.save")
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
  const { t } = useTranslation("tools");
  if (!visible) return null;

  return (
    <div className="rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold">{t("editor.discoveredTools")}</span>
        </div>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {t("editor.toolCount", { count: tools.length })}
        </span>
      </div>

      {tools.length === 0 ? (
        <div className="px-4 py-5 text-sm text-muted-foreground">
          {t("editor.noDiscoveredTools")}
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
  const { t } = useTranslation("tools");
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
          {tool.description || t("common.noDescription")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        <Braces className="size-3" />
        {t("editor.parameterCount", { count: fields.length })}
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
