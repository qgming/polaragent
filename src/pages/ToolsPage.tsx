// Tools 管理页面
// src/pages/ToolsPage.tsx

import { useState, useMemo, type ReactNode } from "react";
import {
  ChevronDown,
  Edit3,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";

import { BUILTIN_TOOLS, TOOL_GROUPS, type ToolMeta } from "@/ai/tools";
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
import { useToast } from "@/hooks/useToast";
import { openExternal } from "@/lib/electron/electron-api";
import { createEmptyMcpTool, mcpTransportLabel } from "@/lib/mcp";
import { useToolsStore } from "@/stores/tools-store";
import type { McpToolConfig } from "@/lib/mcp";

type ToolTab = "discover" | "builtin" | "installed";

export function ToolsPage() {
  const [activeTab, setActiveTab] = useState<ToolTab>("discover");
  const [editor, setEditor] = useState<{
    mode: McpEditorMode;
    tool: McpToolConfig;
  } | null>(null);
  const [expandedMcpIds, setExpandedMcpIds] = useState<string[]>([]);
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
      toast.error(error instanceof Error ? error.message : "打开链接失败");
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

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1120px] px-6 py-6">
        <TopToolbar
          onCreate={() =>
            setEditor({ mode: "create", tool: createEmptyMcpTool() })
          }
        />

        <PageHero
          title="工具"
          bannerTitle="让助手能用上更多外部能力"
          bannerDescription="接入外部服务后，助手能查信息、连平台，把事真正办到底。"
          icon={Wrench}
          kitLabel="Tool Hub"
          rotate="left"
        />

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as ToolTab)}>
          <TabsList className="mt-3 h-9 bg-transparent p-0">
            <TabTrigger value="discover">发现</TabTrigger>
            <TabTrigger value="builtin">内置</TabTrigger>
            <TabTrigger value="installed">
              已安装
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
                      groupName={TOOL_GROUPS[groupKey]?.name ?? groupKey}
                      description={TOOL_GROUPS[groupKey]?.description ?? ""}
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
                title="没有找到内置工具"
                description="内置工具由运行时注册表和 mcp/builtin 自动生成。"
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
                  onDelete={() => removeCustomTool(tool.id)}
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
                title="还没有已安装的 MCP 工具"
                description="可以从发现页找到 MCP 提供商，也可以新建自定义 MCP 工具。"
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
    </div>
  );
}

function TopToolbar({
  onCreate,
}: {
  onCreate: () => void;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      <Button onClick={onCreate}>
        <Plus className="size-4" />
        新增 MCP
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
    <section className="mt-5 overflow-hidden rounded-xl border border-border bg-card">
      {children}
    </section>
  );
}

function BuiltinToolRow({ tool }: { tool: ToolMeta }) {
  const enabled = useToolsStore((state) => state.isBuiltinToolEnabled(tool.id));
  const toggleBuiltinTool = useToolsStore((state) => state.toggleBuiltinTool);

  return (
    <div className="border-b border-border last:border-b-0">
      <ToolRowShell>
        <ToolIdentity
          name={tool.name}
          description={tool.description}
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
            tool.configFields?.some((field) => field.required) ? "需要配置" : null,
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
            title={expanded ? "收起工具清单" : "展开工具清单"}
            onClick={onToggleExpand}
          >
            <ChevronDown
              className={`size-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            />
          </Button>
          {onEdit ? (
            <Button variant="outline" size="sm" title="编辑" onClick={onEdit}>
              <Edit3 className="size-4" />
              编辑
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            title="检测 MCP 是否可用"
            onClick={onCheck}
            disabled={isChecking}
          >
            <RefreshCw className={`size-4 ${isChecking ? "animate-spin" : ""}`} />
            {isChecking ? "检测中" : "检测"}
          </Button>
          {tool.origin !== "builtin" ? (
            <Button variant="outline" size="sm" title="删除" onClick={onDelete}>
              <Trash2 className="size-4" />
              删除
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
  if (tools.length === 0) {
    return (
      <div className="border-t border-border bg-background px-14 py-4 text-sm text-muted-foreground">
        暂未获取到工具清单，编辑保存后会重新拉取。
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
                {remoteTool.description || "暂无描述"}
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
          {description || "暂无描述"}
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
  groupName,
  onToggleExpand,
  onToggleGroup,
  tools,
}: {
  description: string;
  expanded: boolean;
  groupKey: string;
  groupName: string;
  onToggleExpand: () => void;
  onToggleGroup: (enabled: boolean) => void;
  tools: ToolMeta[];
}) {
  const isBuiltinToolEnabled = useToolsStore((state) => state.isBuiltinToolEnabled);
  const toggleBuiltinTool = useToolsStore((state) => state.toggleBuiltinTool);

  // 只要有一个子工具启用,外侧开关就显示为开启
  const someEnabled = tools.some((tool) => isBuiltinToolEnabled(tool.id));
  const enabledCount = tools.filter((tool) => isBuiltinToolEnabled(tool.id)).length;

  return (
    <div className="border-b border-border last:border-b-0">
      <ToolRowShell onClick={onToggleExpand}>
        <ToolIdentity
          name={groupName}
          description={description}
          badges={[`${enabledCount}/${tools.length}`]}
        />
        <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-sm"
            title={expanded ? "收起工具清单" : "展开工具清单"}
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
                    name={tool.name}
                    description={tool.description}
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
