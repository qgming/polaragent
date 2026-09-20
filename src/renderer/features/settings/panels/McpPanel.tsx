import { Globe, RefreshCw, SquareTerminal, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fieldInteractive,
  ghostButton,
  mono,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
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
  McpServerView,
} from "@/shared/contracts/mcp";
import { mcpServerLabel, mcpServerRuleName } from "@/shared/contracts/mcp";
import type { PermissionRuleView } from "@/shared/contracts/permissions";
import type { Settings } from "@/shared/contracts/settings";
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
          description={t("settings.mcpEnabledDesc")}
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

function McpPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [views, setViews] = useState<McpServerView[] | null>(null);
  const [rules, setRules] = useState<PermissionRuleView[]>([]);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
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

  /** 重连并刷新：保存/删除/手动重连都走它，保证面板状态与运行时一致 */
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

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.mcpServers")} description={t("settings.mcpServersDesc")}>
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
              <AddButton
                label={t("settings.mcpAddServer")}
                onClick={() => setEditor({ draft: createMcpDraft(), createdAt: Date.now() })}
              />
            </>
          }
        />

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
        ) : views.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-ink-3">
            {t("settings.mcpEmpty")}
            <span className="mt-1 block text-xs text-ink-4">{t("settings.mcpEmptyHint")}</span>
          </p>
        ) : (
          <div className="space-y-2">
            {views.map(({ config, state }) => {
              const tools = state.tools;
              const hidden = tools.length - TOOL_PREVIEW;
              return (
                <div key={config.id} className="rounded-xl border border-border/60 p-3">
                  <div className="flex items-start justify-between gap-3">
                    {/* 整块信息区就是查看/编辑入口：点击打开与新增同一个弹窗组件 */}
                    <button
                      type="button"
                      className="min-w-0 flex-1 cursor-pointer text-left"
                      onClick={() =>
                        setEditor({ draft: toMcpDraft(config), createdAt: config.createdAt })
                      }
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        {config.transport === "stdio" ? (
                          <SquareTerminal
                            className="size-3.5 shrink-0 text-ink-4"
                            aria-hidden="true"
                          />
                        ) : (
                          <Globe className="size-3.5 shrink-0 text-ink-4" aria-hidden="true" />
                        )}
                        <span className="truncate text-[13.5px] font-medium">
                          {mcpServerLabel(config)}
                        </span>
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
                          <Badge
                            variant="outline"
                            className={cn(mono, "border-border/60 px-1.5 text-ink-4")}
                          >
                            {t("settings.mcpDisabled")}
                          </Badge>
                        )}
                      </div>
                      <p
                        className={cn(mono, "mt-1 truncate text-ink-4")}
                        title={config.transport === "stdio" ? config.command : config.url}
                      >
                        {config.transport === "stdio" ? config.command : config.url}
                      </p>
                      {state.error === undefined ? null : (
                        <p className="mt-1 line-clamp-3 text-xs text-destructive">{state.error}</p>
                      )}
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        aria-label={t("common.delete")}
                        className={cn(ghostButton, "size-6 hover:text-destructive")}
                        onClick={() => setRemoving(config)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
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
                            className={cn(
                              fieldInteractive,
                              mono,
                              "rounded-[8px] px-1.5 py-0.5 text-ink-3",
                            )}
                            title={tool.qualifiedName}
                          >
                            {tool.name}
                            {tool.readOnly === true ? (
                              <span className="ml-1 text-ink-4">
                                {t("settings.mcpToolReadOnly")}
                              </span>
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

                  <div className="mt-2 border-border/60 border-t pt-2">
                    <SettingsField
                      label={t("settings.mcpTrust")}
                      description={t("settings.mcpTrustDesc")}
                      control={
                        <Switch
                          size="sm"
                          checked={trustedNames.has(mcpServerRuleName(config.id))}
                          onCheckedChange={(checked) => void handleToggleTrust(config, checked)}
                        />
                      }
                    />
                  </div>
                </div>
              );
            })}
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
