import { Globe, MoreHorizontal, Pencil, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fieldInteractive,
  ghostButton,
  mono,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow, typePackage } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { Input } from "@/renderer/components/ui/input";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { Textarea } from "@/renderer/components/ui/textarea";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type {
  McpConnectionStatus,
  McpProbeResult,
  McpServerConfig,
  McpServerSource,
  McpServerView,
} from "@/shared/contracts/mcp";
import { mcpServerLabel, mcpServerRuleName } from "@/shared/contracts/mcp";
import type { PermissionRuleView } from "@/shared/contracts/permissions";
import type { Settings } from "@/shared/contracts/settings";
import { findBuiltinMcpServer, MCP_PRESET_CATEGORIES } from "@/shared/mcp/builtin-servers";
import {
  createMcpDraft,
  isMcpDraftReady,
  type McpServerDraft,
  toMcpConfig,
  toMcpDraft,
} from "../mcp-entry";
import {
  AddButton,
  PanelLoading,
  PanelToolbar,
  Segmented,
  SettingsDialog,
  SettingsField,
  SettingsSection,
  secondaryButton,
  settingsInput,
  settingsTextarea,
} from "../settings-shared";

/** 列表里每个 server 最多直接展示几个工具名，其余折叠成 +N */
const TOOL_PREVIEW = 6;

/** 连接状态 → 徽标文案词条（索引查找：noUncheckedIndexedAccess 下要显式兜底） */
const STATUS_LABEL_KEYS: Record<McpConnectionStatus, string> = {
  idle: "settings.mcpStatusIdle",
  connecting: "settings.mcpStatusConnecting",
  ready: "settings.mcpStatusReady",
  error: "settings.mcpStatusError",
};

/** 字段块：眉题 + 控件 + 说明，编辑器内复用（与 ServicesPanel 的 FieldBlock 同形） */
function FieldBlock({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className={typePackage}>{label}</div>
      {children}
      {hint ? <p className="text-xs text-ink-3">{hint}</p> : null}
    </div>
  );
}

interface EditorProps {
  draft: McpServerDraft;
  /** 编辑已有 server 时保留原始创建时间；新建时用当前时间 */
  createdAt: number;
  onChange: (draft: McpServerDraft) => void;
  onClose: () => void;
  onSave: (config: McpServerConfig) => void;
}

/** 统一弹窗壳（settings-shared 的 SettingsDialog）：尺寸与头部/底部与其余四个面板一致 */
function McpServerEditor({ draft, createdAt, onChange, onClose, onSave }: EditorProps) {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<{ running: boolean; result?: McpProbeResult }>({
    running: false,
  });

  const ready = isMcpDraftReady(draft);
  const stdio = draft.transport === "stdio";
  const patch = (next: Partial<McpServerDraft>) => onChange({ ...draft, ...next });

  const runProbe = async () => {
    setProbe({ running: true });
    try {
      const result = await window.oint.mcp.probe(toMcpConfig(draft, createdAt));
      setProbe({ running: false, result });
    } catch (error) {
      setProbe({
        running: false,
        result: { ok: false, reason: error instanceof Error ? error.message : String(error) },
      });
    }
  };

  return (
    <SettingsDialog
      title={draft.name.trim() === "" ? t("settings.mcpAddServer") : t("settings.mcpEditServer")}
      description={t("settings.mcpEditorDesc")}
      onClose={onClose}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={!ready || probe.running}
            onClick={() => void runProbe()}
          >
            {t(probe.running ? "settings.mcpTesting" : "settings.mcpTest")}
          </Button>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={!ready}
              onClick={() => onSave(toMcpConfig(draft, createdAt))}
            >
              {t("common.save")}
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-4">
        <FieldBlock label={t("settings.mcpServerName")} hint={t("settings.mcpServerNameHint")}>
          <Input
            value={draft.name}
            className={settingsInput}
            placeholder="filesystem"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </FieldBlock>

        <SettingsField
          label={t("settings.mcpTransport")}
          description={t("settings.mcpTransportDesc")}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => patch({ transport: stdio ? "http" : "stdio" })}
            >
              {stdio ? (
                <SquareTerminal className="size-3.5" aria-hidden="true" />
              ) : (
                <Globe className="size-3.5" aria-hidden="true" />
              )}
              {t(stdio ? "settings.mcpTransportStdio" : "settings.mcpTransportHttp")}
            </Button>
          }
        />

        {stdio ? (
          <>
            <FieldBlock label={t("settings.mcpCommand")} hint={t("settings.mcpCommandHint")}>
              <Input
                value={draft.command}
                className={settingsInput}
                placeholder="npx"
                onChange={(event) => patch({ command: event.target.value })}
              />
            </FieldBlock>
            <FieldBlock label={t("settings.mcpArgs")} hint={t("settings.mcpArgsHint")}>
              <Textarea
                value={draft.argsText}
                className={settingsTextarea}
                rows={3}
                placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\work"}
                onChange={(event) => patch({ argsText: event.target.value })}
              />
            </FieldBlock>
            <FieldBlock label={t("settings.mcpCwd")} hint={t("settings.mcpCwdHint")}>
              <Input
                value={draft.cwd}
                className={settingsInput}
                placeholder={t("settings.mcpCwdPlaceholder")}
                onChange={(event) => patch({ cwd: event.target.value })}
              />
            </FieldBlock>
            <FieldBlock label={t("settings.mcpEnv")} hint={t("settings.mcpEnvHint")}>
              <Textarea
                value={draft.envText}
                className={settingsTextarea}
                rows={3}
                placeholder="GITHUB_TOKEN=ghp_..."
                onChange={(event) => patch({ envText: event.target.value })}
              />
            </FieldBlock>
          </>
        ) : (
          <>
            <FieldBlock label={t("settings.mcpUrl")} hint={t("settings.mcpUrlHint")}>
              <Input
                value={draft.url}
                className={settingsInput}
                placeholder="https://example.com/mcp"
                onChange={(event) => patch({ url: event.target.value })}
              />
            </FieldBlock>
            <FieldBlock label={t("settings.mcpHeaders")} hint={t("settings.mcpHeadersHint")}>
              <Textarea
                value={draft.headersText}
                className={settingsTextarea}
                rows={3}
                placeholder="Authorization: Bearer ..."
                onChange={(event) => patch({ headersText: event.target.value })}
              />
            </FieldBlock>
          </>
        )}

        <SettingsField
          label={t("settings.mcpEnabled")}
          control={
            <Switch
              size="sm"
              checked={draft.enabled}
              onCheckedChange={(checked) => patch({ enabled: checked })}
            />
          }
        />

        {/* 试连结果：成功给 server 名 + 工具数，失败给原因（含 stderr 尾巴） */}
        {probe.result !== undefined ? (
          <p className={cn("text-[13px]", probe.result.ok ? "text-ink-3" : "text-destructive")}>
            {probe.result.ok
              ? t("settings.mcpTestOk", {
                  name: probe.result.serverName === "" ? draft.id : probe.result.serverName,
                  tools: probe.result.tools.length,
                })
              : t("settings.mcpTestFailed", { reason: probe.result.reason })}
          </p>
        ) : null}
      </div>
    </SettingsDialog>
  );
}

interface ServerCardProps {
  view: McpServerView;
  /** 系统预设的一句话说明（走 i18n）；用户配置没有这句，卡片直接显示命令 / URL */
  description?: string;
  /** 免审批开关：只在用户配置上有；系统预设一律允许，不给开关 */
  trusted?: boolean;
  onToggleTrust?: (checked: boolean) => void;
  /** 用户层：点击卡片打开编辑器 */
  onEdit?: () => void;
  /** 用户层：删除（带二次确认） */
  onRemove?: () => void;
  /** 系统层：启停开关（系统预设不可编辑、不可删除，只能启停） */
  onToggleEnabled?: (checked: boolean) => void;
  /** 只重连这一台（卡片右上角）；busy 时按钮转圈并禁用 */
  onReconnect?: () => void;
  reconnecting?: boolean;
}

/**
 * 一行 server 卡片：系统预设与用户配置**共用这一个组件**。
 *
 * 共用是刻意的：两层卡片的信息层级（名称 / 状态 / 端点 / 工具 / 开关）本来就该一样，
 * 各写一份迟早会在「系统那张卡片没有连接状态」这类细节上分叉。差异只有三处，
 * 都通过可选回调表达：系统层多一个启停开关、少一个删除按钮、点击卡片不进编辑器。
 */
function ServerCard({
  view,
  description,
  trusted,
  onToggleTrust,
  onEdit,
  onRemove,
  onToggleEnabled,
  onReconnect,
  reconnecting = false,
}: ServerCardProps) {
  const { t } = useTranslation();
  const { config, state, source, overridden } = view;
  const tools = state.tools;
  const hidden = tools.length - TOOL_PREVIEW;

  /** 覆盖关系要说清方向：系统行是「没生效」，用户行是「你正在替代预设」 */
  const overrideNote =
    overridden && source === "system"
      ? t("settings.mcpOverriddenByUser")
      : overridden
        ? t("settings.mcpOverridesSystem")
        : null;

  const headline = (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {config.transport === "stdio" ? (
          <SquareTerminal className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
        ) : (
          <Globe className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
        )}
        <span className="truncate text-[13.5px] font-medium">{mcpServerLabel(config)}</span>
        <Badge
          variant="outline"
          className={cn(
            mono,
            "border-border/60 px-1.5",
            state.status === "error" ? "text-destructive" : "text-ink-3",
          )}
        >
          {t(STATUS_LABEL_KEYS[state.status])}
        </Badge>
        {config.enabled ? null : (
          <Badge variant="outline" className={cn(mono, "border-border/60 px-1.5 text-ink-4")}>
            {t("settings.mcpDisabled")}
          </Badge>
        )}
        {overrideNote === null ? null : (
          <Badge variant="outline" className={cn(mono, "border-border/60 px-1.5 text-ink-4")}>
            {overrideNote}
          </Badge>
        )}
      </div>

      {description === undefined ? null : <p className="mt-1 text-xs text-ink-3">{description}</p>}

      <p
        className={cn(mono, "mt-1 truncate text-ink-4")}
        title={config.transport === "stdio" ? config.command : config.url}
      >
        {config.transport === "stdio" ? config.command : config.url}
      </p>

      {state.error === undefined ? null : (
        <p className="mt-1 line-clamp-3 text-xs text-destructive">{state.error}</p>
      )}
    </>
  );

  return (
    <div className="rounded-xl border border-border/60 p-3">
      <div className="flex items-start justify-between gap-3">
        {/* 用户配置：整块信息区就是编辑入口（与新增共用同一个弹窗组件）；系统预设只读，不做成按钮 */}
        {onEdit === undefined ? (
          <div className="min-w-0 flex-1">{headline}</div>
        ) : (
          <button
            type="button"
            className="min-w-0 flex-1 cursor-pointer text-left"
            onClick={onEdit}
          >
            {headline}
          </button>
        )}
        <div className="flex shrink-0 items-center gap-1">
          {/*
            每台 server 一个独立的「重新连接」：只重连这一台，不动其它连接。
            连接失败时它就是「再试一次」；连接正常时它是「刷新工具清单」。
          */}
          {onReconnect === undefined ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={t("settings.mcpReconnect")}
              title={t("settings.mcpReconnect")}
              disabled={reconnecting}
              className={cn(ghostButton, "size-6")}
              onClick={onReconnect}
            >
              <RefreshCw className={cn("size-3.5", reconnecting && "animate-spin")} />
            </Button>
          )}
          {/*
            用户配置的次要操作收进「更多」菜单：卡片右上角只留一个入口，
            删除这类不可撤销的动作不该是一个随时可能误点的裸图标。
          */}
          {onRemove === undefined ? null : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("settings.mcpMoreActions")}
                  title={t("settings.mcpMoreActions")}
                  className={cn(ghostButton, "size-6")}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-36">
                {onEdit === undefined ? null : (
                  <DropdownMenuItem onSelect={onEdit}>
                    <Pencil className="size-3.5" />
                    {t("settings.mcpEditServer")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onSelect={onRemove}>
                  <Trash2 className="size-3.5" />
                  {t("common.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* 工具清单：直接给名字，模型看到的限定名就是它前面加的 mcp__<id>__ */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {tools.length === 0 ? (
          <span className="text-xs text-ink-4">{t("settings.mcpNoTools")}</span>
        ) : (
          <>
            {tools.slice(0, TOOL_PREVIEW).map((tool) => (
              <span
                key={tool.qualifiedName}
                className={cn(fieldInteractive, mono, "rounded-[8px] px-1.5 py-0.5 text-ink-3")}
                title={tool.qualifiedName}
              >
                {tool.name}
                {tool.readOnly === true ? (
                  <span className="ml-1 text-ink-4">{t("settings.mcpToolReadOnly")}</span>
                ) : null}
              </span>
            ))}
            {hidden > 0 ? (
              <span className={cn(mono, "text-ink-4")}>
                {t("settings.mcpToolsMore", { rest: hidden })}
              </span>
            ) : null}
          </>
        )}
      </div>

      <div className="mt-2 space-y-3.5 border-border/60 border-t pt-2">
        {/* 启用开关：系统预设与用户配置都有（后者过去只能进编辑器改，卡片上没有） */}
        {onToggleEnabled === undefined ? null : (
          <SettingsField
            label={t("settings.mcpEnabled")}
            control={
              <Switch size="sm" checked={config.enabled} onCheckedChange={onToggleEnabled} />
            }
          />
        )}
        {/*
          免审批开关只在用户配置上出现：系统预设随包分发、逐条实测过，一律放行
          （见 shared/mcp/builtin-servers.ts 的 isSystemServerTrusted），
          没必要给一个永远该开着的开关。
        */}
        {onToggleTrust === undefined ? null : (
          <SettingsField
            label={t("settings.mcpTrust")}
            control={
              <Switch
                size="sm"
                checked={trusted === true}
                onCheckedChange={(checked) => onToggleTrust(checked)}
              />
            }
          />
        )}
      </div>
    </div>
  );
}

function McpPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [views, setViews] = useState<McpServerView[] | null>(null);
  const [rules, setRules] = useState<PermissionRuleView[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在重连的那一台 server（卡片上的按钮据此转圈；null = 没有在重连的） */
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);
  // 来源页签：系统 = 随应用分发的预设（只读，可启停），用户 = 自己新增的配置
  const [source, setSource] = useState<McpServerSource>("system");
  const [editor, setEditor] = useState<{ draft: McpServerDraft; createdAt: number } | null>(null);
  const [removing, setRemoving] = useState<McpServerConfig | null>(null);

  const refresh = useCallback(async () => {
    setFailed(false);
    try {
      const [next, nextRules] = await Promise.all([
        window.oint.mcp.list(),
        window.oint.permissions.listRules(),
      ]);
      setViews(next);
      setRules(nextRules);
    } catch {
      setFailed(true);
      setViews([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** 重连并刷新：保存/删除/启停/手动重连都走它，保证面板状态与运行时一致 */
  const reload = useCallback(async () => {
    setBusy(true);
    try {
      setViews(await window.oint.mcp.reload());
      setRules(await window.oint.permissions.listRules().catch(() => []));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * 只重连一台 server（卡片右上角那个按钮）。
   *
   * `reconnectingId` 记住是哪一张卡片在转圈：整页 busy 会把所有卡片都变成禁用态，
   * 而用户点的只是其中一台。
   */
  const handleReconnect = async (config: McpServerConfig) => {
    setReconnectingId(config.id);
    try {
      setViews(await window.oint.mcp.reconnect(config.id));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setReconnectingId(null);
    }
  };

  const handleSave = async (config: McpServerConfig) => {
    setEditor(null);
    const next = [...settings.mcpServers];
    const index = next.findIndex((item) => item.id === config.id);
    if (index >= 0) next[index] = config;
    else next.push(config);
    await update({ mcpServers: next });
    await reload();
  };

  const handleRemove = async (config: McpServerConfig) => {
    setRemoving(null);
    await update({ mcpServers: settings.mcpServers.filter((item) => item.id !== config.id) });
    // 顺带清掉该 server 的批量授权规则：server 都删了，放行规则只会留成悬空条目
    await window.oint.permissions.removeRule(mcpServerRuleName(config.id)).catch(() => undefined);
    await reload();
  };

  /**
   * 系统预设的启停：写进 `systemMcpServerEnabled` 的**显式选择表**（缺省时跟随预设默认值）。
   *
   * 记显式选择而不是「禁用表」的原因见 contracts/settings.ts：预设的默认值未来可能不一致，
   * 只记禁用的话「默认关的那个被打开了」就无处可记。
   */
  const handleToggleSystem = async (config: McpServerConfig, enabled: boolean) => {
    await update({
      systemMcpServerEnabled: { ...settings.systemMcpServerEnabled, [config.id]: enabled },
    });
    await reload();
  };

  /**
   * 用户配置的启停：直接改 `settings.mcpServers` 里那一条的 `enabled`。
   *
   * 与系统预设的差别只在「记在哪」：系统预设的配置住在代码注册表里，用户那份只能记「显式选择」；
   * 而用户配置本来就是自己的数据，改它自己那一条即可。
   */
  const handleToggleUserEnabled = async (config: McpServerConfig, enabled: boolean) => {
    await update({
      mcpServers: settings.mcpServers.map((item) =>
        item.id === config.id ? { ...item, enabled } : item,
      ),
    });
    await reload();
  };

  /**
   * 用户配置的免审批开关：写 `mcp__<id>__*` 前缀规则。
   *
   * 只有用户自加的 server 会走到这里 —— 系统预设一律允许、界面不给开关
   *（见 shared/mcp/builtin-servers.ts 的 isSystemServerTrusted）。
   */
  const handleToggleTrust = async (config: McpServerConfig, trusted: boolean) => {
    const ruleName = mcpServerRuleName(config.id);
    try {
      if (trusted) {
        await window.oint.permissions.addRule({ toolName: ruleName, createdAt: Date.now() });
      } else {
        await window.oint.permissions.removeRule(ruleName);
      }
    } catch {
      // 写规则失败不该静默：下面重新读一遍，让开关回到真实状态
    }
    setRules(await window.oint.permissions.listRules().catch(() => []));
  };

  const trustedNames = new Set(rules.map((rule) => rule.toolName));

  const visible = (views ?? []).filter((view) => view.source === source);
  const system = source === "system";

  /**
   * 系统页签按领域分组渲染。
   *
   * 三十多台预设平铺成一张长列表时，用户找「有没有天气类的」只能靠眼扫；
   * 分组顺序与注册表里的 MCP_PRESET_CATEGORIES 一致（越靠前越通用）。
   */
  const grouped = MCP_PRESET_CATEGORIES.map((category) => ({
    category,
    items: visible.filter((view) => findBuiltinMcpServer(view.config.id)?.category === category),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t(system ? "settings.mcpSystemServers" : "settings.mcpServers")}
        description={t(system ? "settings.mcpSystemServersDesc" : "settings.mcpServersDesc")}
      >
        <PanelToolbar
          action={
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={secondaryButton}
                disabled={busy}
                onClick={() => void reload()}
              >
                <RefreshCw className={cn("size-3.5", busy && "animate-spin")} aria-hidden="true" />
                {t(busy ? "settings.mcpReconnecting" : "settings.mcpReconnect")}
              </Button>
              {/* 系统预设随包分发：没有「添加」，也没有「编辑 / 删除」 */}
              {system ? null : (
                <AddButton
                  label={t("settings.mcpAddServer")}
                  onClick={() => setEditor({ draft: createMcpDraft(), createdAt: Date.now() })}
                />
              )}
            </>
          }
        >
          <Segmented<McpServerSource>
            ariaLabel={t("settings.sourceLabel")}
            value={source}
            onChange={setSource}
            options={[
              { value: "system", label: t("settings.sourceTabSystem") },
              { value: "user", label: t("settings.sourceTabUser") },
            ]}
          />
        </PanelToolbar>

        {failed ? (
          <div className="flex items-center gap-2">
            <p className="text-[13px] text-destructive">{t("errors.loadFailed")}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void refresh()}
            >
              {t("common.retry")}
            </Button>
          </div>
        ) : views === null ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : visible.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-ink-3">
            {t(system ? "settings.mcpSystemEmpty" : "settings.mcpEmpty")}
            <span className="mt-1 block text-xs text-ink-4">
              {t(system ? "settings.mcpSystemEmptyHint" : "settings.mcpEmptyHint")}
            </span>
          </p>
        ) : (
          <div className="space-y-4">
            {/* 系统页签按领域分组；用户页签就是一串自己的配置，不需要分组 */}
            {(system ? grouped : [{ category: null, items: visible }]).map((group) => (
              <div key={group.category ?? "user"} className="space-y-2">
                {group.category === null ? null : (
                  <h4 className={typeEyebrow}>
                    {t(`settings.mcpPresetCategory.${group.category}`)}
                  </h4>
                )}
                {group.items.map((view) => {
                  const preset = findBuiltinMcpServer(view.config.id);
                  return (
                    <ServerCard
                      key={`${view.source}:${view.config.id}`}
                      view={view}
                      // 系统预设的说明来自注册表的 i18n 键（品牌名不翻译，说明跟着界面语言走）
                      {...(preset === undefined ? {} : { description: t(preset.descriptionKey) })}
                      onReconnect={() => void handleReconnect(view.config)}
                      reconnecting={reconnectingId === view.config.id}
                      {...(system
                        ? {
                            // 系统预设一律允许，不给免审批开关；用户配置才有
                            onToggleEnabled: (checked: boolean) =>
                              void handleToggleSystem(view.config, checked),
                          }
                        : {
                            trusted: trustedNames.has(mcpServerRuleName(view.config.id)),
                            onToggleTrust: (checked: boolean) =>
                              void handleToggleTrust(view.config, checked),
                            // 用户配置同样有启用开关：停用会断开连接、工具也不再给模型
                            onToggleEnabled: (checked: boolean) =>
                              void handleToggleUserEnabled(view.config, checked),
                            onEdit: () =>
                              setEditor({
                                draft: toMcpDraft(view.config),
                                createdAt: view.config.createdAt,
                              }),
                            onRemove: () => setRemoving(view.config),
                          })}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      <SettingsSection title={t("settings.mcpNotice")}>
        <p className="text-[13px] text-ink-3">{t("settings.mcpNoticeDesc")}</p>
      </SettingsSection>

      {editor === null ? null : (
        <McpServerEditor
          draft={editor.draft}
          createdAt={editor.createdAt}
          onChange={(draft) => setEditor({ draft, createdAt: editor.createdAt })}
          onClose={() => setEditor(null)}
          onSave={(config) => void handleSave(config)}
        />
      )}

      {/* 删除确认：外部 server 的配置删掉后要重填，值得一次二次确认 */}
      <Dialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>
              {t("settings.mcpRemoveDesc", {
                name: removing === null ? "" : mcpServerLabel(removing),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRemoving(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (removing !== null) void handleRemove(removing);
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function McpPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <McpPanelBody settings={settings} />;
}
