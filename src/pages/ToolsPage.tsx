// Tools 管理页面
// src/pages/ToolsPage.tsx

import { useState, useMemo, useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown,
  Edit3,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";

import {
  BUILTIN_TOOLS,
  TOOL_GROUPS,
  type ToolCapabilities,
  type ToolMeta,
} from "@/ai/tools";
import {
  McpToolEditorModal,
  type McpEditorMode,
} from "@/components/mcp/McpToolEditorModal";
import { PageHero } from "@/components/PageHero";
import { McpInstallStatusBadge } from "@/components/mcp/McpInstallStatusBadge";
import { McpProviderDiscovery } from "@/components/mcp/McpProviderDiscovery";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useToast } from "@/hooks/useToast";
import { openExternal } from "@/lib/electron/electron-api";
import { createEmptyMcpTool, mcpTransportLabel } from "@/lib/mcp";
import { useToolsStore } from "@/stores/tools-store";
import type { McpToolConfig } from "@/lib/mcp";

type ToolTab = "discover" | "builtin" | "installed";

export function ToolsPage() {
  const { t } = useTranslation("tools");
  const [activeTab, setActiveTab] = useState<ToolTab>("discover");
  const [editor, setEditor] = useState<{
    mode: McpEditorMode;
    tool: McpToolConfig;
  } | null>(null);
  const [expandedMcpIds, setExpandedMcpIds] = useState<string[]>([]);
  const [browserStatus, setBrowserStatus] = useState<{ connected: boolean } | null>(null);
  const [computerStatus, setComputerStatus] = useState<{ ok: boolean } | null>(null);
  const [deletingTool, setDeletingTool] = useState<McpToolConfig | null>(null);
  const toast = useToast();

  const builtinMcpTools = useToolsStore((state) => state.builtinMcpTools);
  const customTools = useToolsStore((state) => state.customTools);
  const addCustomTool = useToolsStore((state) => state.addCustomTool);
  const addCustomTools = useToolsStore((state) => state.addCustomTools);
  const updateCustomTool = useToolsStore((state) => state.updateCustomTool);
  const toggleMcpRemoteTool = useToolsStore((state) => state.toggleMcpRemoteTool);
  const removeCustomTool = useToolsStore((state) => state.removeCustomTool);
  const checkMcpTool = useToolsStore((state) => state.checkMcpTool);
  const expandedGroups = useToolsStore((state) => state.expandedGroups);
  const toggleGroupExpand = useToolsStore((state) => state.toggleGroupExpand);
  const toggleGroup = useToolsStore((state) => state.toggleGroup);

  // 定期检查 Browser Use 和 Computer Use 状态
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const browserResult = await window.polaragent.browseruse.status();
        setBrowserStatus({ connected: Boolean(browserResult?.connected) });
      } catch {
        setBrowserStatus({ connected: false });
      }

      try {
        const computerResult = await window.polaragent.computeruse.health();
        setComputerStatus({ ok: Boolean(computerResult?.ok) });
      } catch {
        setComputerStatus({ ok: false });
      }
    };

    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 10000); // 每10秒检查一次
    return () => window.clearInterval(timer);
  }, []);

  // 按 group 分组内置工具
  const groupedTools = useMemo(() => {
    const byGroup = new Map<string, ToolMeta[]>();
    BUILTIN_TOOLS.forEach((tool) => {
      const key = tool.group ?? "__ungrouped";
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(tool);
    });
    return Array.from(byGroup.entries()).sort(
      ([a], [b]) => (TOOL_GROUPS[a]?.order ?? 999) - (TOOL_GROUPS[b]?.order ?? 999),
    );
  }, []);

  const openExternalUrl = async (url: string) => {
    try {
      await openExternal(url);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("errors.openLinkFailed"));
    }
  };

  const saveMcpTool = async (tool: McpToolConfig) => {
    if (!editor) return;
    if (editor.mode === "create") {
      await addCustomTool(tool);
      setActiveTab("installed");
    } else if (editor.mode === "edit") {
      await updateCustomTool(editor.tool.id, tool);
    } else {
      await addCustomTool({ ...tool, origin: "market" });
      setActiveTab("installed");
    }
    setEditor(null);
  };

  const saveManyMcpTools = async (tools: McpToolConfig[]) => {
    await addCustomTools(tools);
    setActiveTab("installed");
    setEditor(null);
  };

  // 删除 MCP 工具
  const handleDeleteTool = () => {
    if (!deletingTool) return;
    removeCustomTool(deletingTool.id);
    toast.success(t("delete.success", { name: deletingTool.name }));
    setDeletingTool(null);
  };

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1120px] px-6 py-6">
        <TopToolbar
          onCreate={() =>
            setEditor({ mode: "create", tool: createEmptyMcpTool() })
          }
        />

        <PageHero
          title={t("page.title")}
          bannerTitle={t("page.bannerTitle")}
          bannerDescription={t("page.bannerDescription")}
          icon={Wrench}
          kitLabel={t("page.kitLabel")}
          rotate="left"
        />

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ToolTab)}>
          <TabsList className="mt-3 h-9 bg-transparent p-0">
            <TabTrigger value="discover">{t("tabs.discover")}</TabTrigger>
            <TabTrigger value="builtin">{t("tabs.builtin")}</TabTrigger>
            <TabTrigger value="installed">
              {t("tabs.installed")}
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs">
                {customTools.length}
              </span>
            </TabTrigger>
          </TabsList>
        </Tabs>

        {activeTab === "discover" ? (
          <McpProviderDiscovery
            onOpenUrl={(url) => void openExternalUrl(url)}
          />
        ) : null}

        {activeTab === "builtin" ? (
          <ToolSection>
            {BUILTIN_TOOLS.length + builtinMcpTools.length > 0 ? (
              <>
                {builtinMcpTools.map((tool) => (
                  <McpToolRow
                    key={tool.id}
                    tool={tool}
                    expanded={expandedMcpIds.includes(tool.id)}
                    onToggleExpand={() =>
                      setExpandedMcpIds((ids) =>
                        ids.includes(tool.id)
                          ? ids.filter((id) => id !== tool.id)
                          : [...ids, tool.id],
                      )
                    }
                    onToggleRemoteTool={(remoteToolName, enabled) =>
                      void toggleMcpRemoteTool(tool.id, remoteToolName, enabled)
                    }
                    onCheck={() => void checkMcpTool(tool.id)}
                  />
                ))}
                {groupedTools
                  .filter(([key]) => key !== "__ungrouped")
                  .map(([groupKey, tools]) => (
                    <ToolGroupRow
                      key={groupKey}
                      groupKey={groupKey}
                      groupName={t(`builtin.groups.${groupKey}.name`, { defaultValue: TOOL_GROUPS[groupKey]?.name ?? groupKey })}
                      description={t(`builtin.groups.${groupKey}.description`, { defaultValue: TOOL_GROUPS[groupKey]?.description ?? "" })}
                      tools={tools}
                      expanded={expandedGroups.includes(groupKey)}
                      onToggleExpand={() => toggleGroupExpand(groupKey)}
                      onToggleGroup={(enabled) =>
                        toggleGroup(
                          groupKey,
                          enabled,
                          tools.map((t) => t.id),
                        )
                      }
                      status={
                        groupKey === "browseruse"
                          ? browserStatus
                          : groupKey === "computeruse"
                            ? computerStatus
                            : null
                      }
                    />
                  ))}
                {(groupedTools.find(([key]) => key === "__ungrouped")?.[1] ?? []).map(
                  (tool) => (
                    <BuiltinToolRow key={tool.id} tool={tool} />
                  ),
                )}
              </>
            ) : (
              <EmptyCloudState
                title={t("empty.builtinTitle")}
                description={t("empty.builtinDescription")}
                compact
              />
            )}
          </ToolSection>
        ) : null}

        {activeTab === "installed" ? (
          <ToolSection>
            {customTools.length > 0 ? (
              customTools.map((tool) => (
                <McpToolRow
                  key={tool.id}
                  tool={tool}
                  expanded={expandedMcpIds.includes(tool.id)}
                  onEdit={() => setEditor({ mode: "edit", tool })}
                  onDelete={() => setDeletingTool(tool)}
                  onToggleExpand={() =>
                    setExpandedMcpIds((ids) =>
                      ids.includes(tool.id)
                        ? ids.filter((id) => id !== tool.id)
                        : [...ids, tool.id],
                    )
                  }
                  onToggleRemoteTool={(remoteToolName, enabled) =>
                    void toggleMcpRemoteTool(tool.id, remoteToolName, enabled)
                  }
                  onCheck={() => void checkMcpTool(tool.id)}
                />
              ))
            ) : (
              <EmptyCloudState
                title={t("empty.installedTitle")}
                description={t("empty.installedDescription")}
                compact
              />
            )}
          </ToolSection>
        ) : null}
      </div>

      <McpToolEditorModal
        open={editor !== null}
        mode={editor?.mode ?? "create"}
        tool={editor?.tool ?? createEmptyMcpTool()}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
        onSave={saveMcpTool}
        onSaveMany={saveManyMcpTools}
      />

      <ConfirmDialog
        open={deletingTool !== null}
        onOpenChange={(open) => !open && setDeletingTool(null)}
        title={t("delete.title")}
        message={t("delete.message", { name: deletingTool?.name })}
        confirmLabel={t("delete.confirm")}
        variant="destructive"
        onConfirm={handleDeleteTool}
      />
    </div>
  );
}

function TopToolbar({
  onCreate,
}: {
  onCreate: () => void;
}) {
  const { t } = useTranslation("tools");
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      <Button onClick={onCreate}>
        <Plus className="size-4" />
        {t("toolbar.addMcp")}
      </Button>
    </div>
  );
}

function TabTrigger({
  children,
  value,
}: {
  children: ReactNode;
  value: ToolTab;
}) {
  return (
    <TabsTrigger
      value={value}
      className="mr-7 h-9 gap-2 rounded-none bg-transparent px-0 text-base font-semibold text-muted-foreground shadow-none data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none"
    >
      {children}
    </TabsTrigger>
  );
}

function ToolSection({ children }: { children: ReactNode }) {
  return (
    <section className="mt-3 overflow-hidden rounded-xl border border-border bg-card">
      {children}
    </section>
  );
}

function BuiltinToolRow({ tool }: { tool: ToolMeta }) {
  const { t } = useTranslation("tools");
  const enabled = useToolsStore((state) => state.isBuiltinToolEnabled(tool.id));
  const toggleBuiltinTool = useToolsStore((state) => state.toggleBuiltinTool);

  return (
    <div className="border-b border-border last:border-b-0">
      <ToolRowShell>
        <ToolIdentity
          name={t(`builtin.tools.${tool.id}.name`, { defaultValue: tool.name })}
          description={t(`builtin.tools.${tool.id}.description`, { defaultValue: tool.description })}
          badges={capabilityBadges(t, tool.capabilities)}
        />
        <div className="flex items-center gap-3">
          <Switch
            checked={enabled}
            onCheckedChange={(next) => toggleBuiltinTool(tool.id, next)}
          />
        </div>
      </ToolRowShell>
    </div>
  );
}

function McpToolRow({
  expanded,
  onDelete,
  onEdit,
  onCheck,
  onToggleExpand,
  onToggleRemoteTool,
  tool,
}: {
  expanded?: boolean;
  onDelete?: () => void;
  onEdit?: () => void;
  onCheck?: () => void;
  onToggleExpand?: () => void;
  onToggleRemoteTool?: (remoteToolName: string, enabled: boolean) => void;
  tool: McpToolConfig;
}) {
  const { t } = useTranslation("tools");
  const enabled = useToolsStore((state) => state.isMcpServerEnabled(tool.id));
  const toggleMcpServer = useToolsStore((state) => state.toggleMcpServer);
  const isMcpRemoteToolEnabled = useToolsStore(
    (state) => state.isMcpRemoteToolEnabled,
  );
  const disabledRemoteTools = new Set(tool.disabledToolNames ?? []);
  const enabledToolCount = enabled
    ? (tool.discoveredTools ?? []).filter(
        (item) => !disabledRemoteTools.has(item.name),
      ).length
    : 0;
  const isChecking = tool.installCheck?.status === "checking";

  return (
    <div className="border-b border-border last:border-b-0">
      <ToolRowShell onClick={onToggleExpand}>
        <ToolIdentity
          name={tool.name}
          description={tool.description}
          meta={[
            "MCP",
            tool.category,
            mcpTransportLabel(tool.server.transport),
            tool.configFields?.some((field) => field.required) ? t("mcp.requiresConfig") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          badges={[
            `${enabledToolCount}/${tool.discoveredTools?.length ?? 0}`,
          ]}
          status={<McpInstallStatusBadge check={tool.installCheck} />}
        />
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-sm"
            title={expanded ? t("mcp.collapseTools") : t("mcp.expandTools")}
            onClick={onToggleExpand}
          >
            <ChevronDown
              className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
          {onEdit ? (
            <Button variant="outline" size="sm" title={t("actions.edit")} onClick={onEdit}>
              <Edit3 className="size-4" />
              {t("actions.edit")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            title={t("actions.checkTitle")}
            onClick={onCheck}
            disabled={isChecking}
          >
            <RefreshCw className={`size-4 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? t("actions.checking") : t("actions.check")}
          </Button>
          {tool.origin !== "builtin" ? (
            <Button variant="outline" size="sm" title={t("actions.delete")} onClick={onDelete}>
              <Trash2 className="size-4" />
              {t("actions.delete")}
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            onCheckedChange={(next) => toggleMcpServer(tool.id, next)}
          />
        </div>
      </ToolRowShell>
      {expanded ? (
        <RemoteToolList
          serverEnabled={enabled}
          isToolEnabled={(remoteToolName) =>
            isMcpRemoteToolEnabled(tool.id, remoteToolName)
          }
          tools={tool.discoveredTools ?? []}
          onToggleTool={onToggleRemoteTool}
        />
      ) : null}
    </div>
  );
}

function ToolRowShell({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      className={`grid min-h-[88px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-5 py-4 ${
        onClick ? "cursor-pointer hover:bg-muted/40" : ""
      }`}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

function RemoteToolList({
  isToolEnabled,
  onToggleTool,
  serverEnabled,
  tools,
}: {
  isToolEnabled: (remoteToolName: string) => boolean;
  onToggleTool?: (remoteToolName: string, enabled: boolean) => void;
  serverEnabled: boolean;
  tools: NonNullable<McpToolConfig["discoveredTools"]>;
}) {
  const { t } = useTranslation("tools");
  if (tools.length === 0) {
    return (
      <div className="border-t border-border bg-background px-14 py-4 text-sm text-muted-foreground">
        {t("mcp.noRemoteTools")}
      </div>
    );
  }

  return (
    <div className="border-t border-border bg-background">
      <div>
        {tools.map((remoteTool) => (
          <div
            key={remoteTool.name}
            className="grid min-h-[76px] grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-border bg-card px-5 py-3 last:border-b-0"
          >
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold">
                  {remoteTool.title || remoteTool.name}
                </h3>
                {remoteTool.title && remoteTool.title !== remoteTool.name ? (
                  <code className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {remoteTool.name}
                  </code>
                ) : null}
              </div>
              <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                {remoteTool.description || t("common.noDescription")}
              </p>
            </div>
            <Switch
              checked={serverEnabled && isToolEnabled(remoteTool.name)}
              disabled={!serverEnabled}
              onCheckedChange={(enabled) => onToggleTool?.(remoteTool.name, enabled)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ToolIdentity({
  badges,
  description,
  meta,
  name,
  status,
}: {
  badges?: string[];
  description: string;
  meta?: string;
  name: string;
  status?: ReactNode;
}) {
  const { t } = useTranslation("tools");
  return (
    <div className="flex min-w-0 items-center">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h3 className="truncate text-base font-semibold">{name}</h3>
          {meta ? (
            <span className="rounded-full bg-background px-2 py-0.5 text-xs text-muted-foreground">
              {meta}
            </span>
          ) : null}
          {badges?.map((badge) => (
            <span
              key={badge}
              className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {badge}
            </span>
          ))}
          {status}
        </div>
        <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
          {description || t("common.noDescription")}
        </p>
      </div>
    </div>
  );
}

function EmptyCloudState({
  compact,
  description,
  title,
}: {
  compact?: boolean;
  description: string;
  title: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${
        compact ? "px-6 py-12" : "mt-20 px-6 py-16"
      }`}
    >
      <FolderOpen
        className={`text-muted-foreground/40 ${compact ? "size-10" : "size-12"}`}
      />
      <h3
        className={`font-semibold text-foreground ${
          compact ? "mt-3 text-sm" : "mt-4 text-base"
        }`}
      >
        {title}
      </h3>
      <p
        className={`max-w-[420px] text-muted-foreground ${
          compact ? "mt-1.5 text-xs" : "mt-2 text-sm"
        }`}
      >
        {description}
      </p>
    </div>
  );
}

function ToolGroupRow({
  description,
  expanded,
  groupKey,
  groupName,
  onToggleExpand,
  onToggleGroup,
  status,
  tools,
}: {
  description: string;
  expanded: boolean;
  groupKey: string;
  groupName: string;
  onToggleExpand: () => void;
  onToggleGroup: (enabled: boolean) => void;
  status?: { connected?: boolean; ok?: boolean } | null;
  tools: ToolMeta[];
}) {
  const { t } = useTranslation("tools");
  const isBuiltinToolEnabled = useToolsStore((state) => state.isBuiltinToolEnabled);
  const toggleBuiltinTool = useToolsStore((state) => state.toggleBuiltinTool);

  // 只要有一个子工具启用,外侧开关就显示为开启
  const someEnabled = tools.some((tool) => isBuiltinToolEnabled(tool.id));
  const enabledCount = tools.filter((tool) => isBuiltinToolEnabled(tool.id)).length;

  // 根据分组类型显示不同的状态
  let statusBadge: ReactNode = null;
  if (status) {
    if (groupKey === "browseruse") {
      const connected = status.connected ?? false;
      statusBadge = (
        <span
          className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${
            connected
              ? "bg-emerald-500/10 text-emerald-700"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {connected ? t("status.connected") : t("status.disconnected")}
        </span>
      );
    } else if (groupKey === "computeruse") {
      const available = status.ok ?? false;
      statusBadge = (
        <span
          className={`inline-flex h-5 items-center rounded-full px-2 text-xs font-medium ${
            available
              ? "bg-emerald-500/10 text-emerald-700"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {available ? t("status.available") : t("status.pendingCheck")}
        </span>
      );
    }
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <ToolRowShell onClick={onToggleExpand}>
        <ToolIdentity
          name={groupName}
          description={description}
          badges={[`${enabledCount}/${tools.length}`]}
          status={statusBadge}
        />
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-sm"
            title={expanded ? t("mcp.collapseTools") : t("mcp.expandTools")}
            onClick={onToggleExpand}
          >
            <ChevronDown
              className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
          <Switch
            checked={someEnabled}
            onCheckedChange={onToggleGroup}
          />
        </div>
      </ToolRowShell>
      {expanded ? (
        <div className="border-t border-border bg-background">
          {tools.map((tool) => (
            <div
              key={tool.id}
              className="border-b border-border bg-card last:border-b-0"
            >
              <ToolRowShell>
                <div className="pl-6">
                  <ToolIdentity
                    name={t(`builtin.tools.${tool.id}.name`, { defaultValue: tool.name })}
                    description={t(`builtin.tools.${tool.id}.description`, { defaultValue: tool.description })}
                    badges={capabilityBadges(t, tool.capabilities)}
                  />
                </div>
                <Switch
                  checked={isBuiltinToolEnabled(tool.id)}
                  onCheckedChange={(next) => toggleBuiltinTool(tool.id, next)}
                />
              </ToolRowShell>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function capabilityBadges(
  t: (key: string) => string,
  capabilities?: ToolCapabilities,
): string[] {
  if (!capabilities) return [];
  const badges: string[] = [];
  if (capabilities.supportsProgress) badges.push(t("capabilities.progress"));
  if (capabilities.supportsCancel) badges.push(t("capabilities.cancel"));
  if (capabilities.supportsBackground) badges.push(t("capabilities.background"));
  if (capabilities.estimatedDuration && capabilities.estimatedDuration !== "short") {
    badges.push(t(`capabilities.duration.${capabilities.estimatedDuration}`));
  }
  if (
    capabilities.resultDisplay === "artifact" ||
    capabilities.resultDisplay === "widget" ||
    capabilities.resultDisplay === "audio"
  ) {
    badges.push(t(`capabilities.result.${capabilities.resultDisplay}`));
  }
  return badges;
}
