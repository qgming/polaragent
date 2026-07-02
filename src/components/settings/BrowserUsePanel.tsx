// Browser Use 设置面板
// src/components/settings/BrowserUsePanel.tsx

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, Bug, Globe, Loader2, Save, Server, FolderDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutomationConfig, Settings } from "@/types/config";
import { PageTitle, SettingRow } from "./settings-shared";
import { clampNumber } from "@/lib/utils";

type BrowserStatus = Awaited<ReturnType<typeof window.polaragent.browseruse.status>>;

const DEFAULT_BROWSER_USE = {
  wsPort: 18765,
  apiPort: 18767,
  enableHttpApi: false,
  actionTimeoutMs: 30000,
  waitAfterActionMs: 300,
  verboseLogs: false,
};

export function BrowserUsePanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const browserUse = useMemo(
    () => ({
      ...DEFAULT_BROWSER_USE,
      ...settings.automation?.browserUse,
    }),
    [settings.automation],
  );

  const [draft, setDraft] = useState(browserUse);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);

  useEffect(() => {
    setDraft(browserUse);
  }, [browserUse]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  async function refreshStatus() {
    try {
      const next = await window.polaragent.browseruse.status();
      setStatus(next);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const nextAutomation: AutomationConfig = {
      ...settings.automation,
      browserUse: {
        wsPort: clampPort(draft.wsPort, DEFAULT_BROWSER_USE.wsPort),
        apiPort: clampPort(draft.apiPort, DEFAULT_BROWSER_USE.apiPort),
        enableHttpApi: draft.enableHttpApi,
        actionTimeoutMs: clampNumber(draft.actionTimeoutMs, 30000, 1000, 180000),
        waitAfterActionMs: clampNumber(draft.waitAfterActionMs, 300, 0, 10000),
        verboseLogs: draft.verboseLogs,
      },
      computerUse: {
        persistentWorker: true,
        defaultMaxDepth: 5,
        defaultMaxNodes: 250,
        includeScreenshotByDefault: true,
        screenshotMode: "path",
        restoreClipboard: true,
        actionTimeoutMs: 60000,
        ...settings.automation?.computerUse,
      },
    };

    try {
      await onUpdate({ automation: nextAutomation });
      const nextStatus = await window.polaragent.browseruse.configure(nextAutomation.browserUse);
      setStatus(nextStatus);
      setMessage(t("browserUse.saved"));
    } catch (error) {
      setMessage(t("browserUse.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  }

  async function exportExtension() {
    setExporting(true);
    setMessage(null);
    try {
      const result = await window.polaragent.browseruse.exportExtension();
      if (result.ok && result.path) {
        setExportPath(result.path);
        setMessage(t("browserUse.exported", { path: result.path }));
      } else {
        setMessage(result.error || t("browserUse.exportFailed"));
      }
    } catch (error) {
      setMessage(t("browserUse.exportFailedWithMessage", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setExporting(false);
    }
  }

  const connected = Boolean(status?.connected);
  const tabCount = status?.tabs?.length ?? 0;

  return (
    <section>
      <PageTitle
        title="Browser Use"
        description={t("browserUse.description")}
      />

      {/* 连接状态卡片 */}
      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-foreground" />
              <h2 className="text-sm font-semibold">Browser Use</h2>
            </div>
            <StatusPill active={connected} activeText={t("browserUse.connected")} inactiveText={t("browserUse.disconnected")} />
          </div>
        </div>

        <div className="grid gap-4 px-5 py-5 md:grid-cols-3">
          <Metric icon={Server} label={t("browserUse.websocketPort")} value={String(status?.ports.extension ?? draft.wsPort)} />
          <Metric icon={Activity} label={t("browserUse.availableTabs")} value={t("browserUse.tabCount", { count: tabCount })} />
          <Metric icon={Bug} label={t("browserUse.queuedTasks")} value={String(status?.pendingRequests ?? 0)} />
        </div>

        <div className="border-t border-border">
          <SettingRow
            title={t("browserUse.websocketPort")}
            description={t("browserUse.websocketPortDesc")}
            control={
              <NumberInput
                value={draft.wsPort}
                onChange={(value) => setDraft({ ...draft, wsPort: value })}
              />
            }
          />
          <SettingRow
            title={t("browserUse.actionTimeout")}
            description={t("browserUse.actionTimeoutDesc")}
            control={
              <NumberInput
                suffix="ms"
                value={draft.actionTimeoutMs}
                onChange={(value) => setDraft({ ...draft, actionTimeoutMs: value })}
              />
            }
          />
          <SettingRow
            title={t("browserUse.waitAfterAction")}
            description={t("browserUse.waitAfterActionDesc")}
            control={
              <NumberInput
                suffix="ms"
                value={draft.waitAfterActionMs}
                onChange={(value) => setDraft({ ...draft, waitAfterActionMs: value })}
              />
            }
          />
        </div>

        <div className="border-t border-border px-5 py-4">
          <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
            <InfoLine label="Profile" value={status?.extension?.profileLabel || status?.extension?.profileId || t("browserUse.notConnected")} />
            <InfoLine label={t("browserUse.lastError")} value={status?.lastError || t("browserUse.none")} />
          </div>
          {message ? <p className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t("browserUse.saveApply")}
            </Button>
          </div>
        </div>
      </div>

      {/* 扩展安装卡片 */}
      <div className="mt-4 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <FolderDown className="size-4 text-foreground" />
            <h2 className="text-sm font-semibold">{t("browserUse.installExtension")}</h2>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <p className="text-sm text-muted-foreground">
            {t("browserUse.installDesc")}
          </p>

          {exportPath && (
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-xs text-muted-foreground">{t("browserUse.exportLocation")}</p>
              <p className="mt-1 break-all text-sm font-mono">{exportPath}</p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void exportExtension()} disabled={exporting} size="sm">
              {exporting ? <Loader2 className="size-4 animate-spin" /> : <FolderDown className="size-4" />}
              {t("browserUse.exportButton")}
            </Button>
          </div>

          <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
            <p className="text-xs font-semibold text-foreground">{t("browserUse.installSteps")}</p>
            <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
              <li>{t("browserUse.step1")}</li>
              <li>{t("browserUse.step2")} <code className="rounded bg-background px-1 py-0.5 font-mono text-xs">chrome://extensions</code></li>
              <li>{t("browserUse.step3")}</li>
              <li>{t("browserUse.step4")}</li>
              <li>{t("browserUse.step5")}</li>
              <li>{t("browserUse.step6")}</li>
            </ol>
          </div>
        </div>
      </div>
    </section>
  );
}

function StatusPill({
  active,
  activeText,
  inactiveText,
}: {
  active: boolean;
  activeText: string;
  inactiveText: string;
}) {
  return (
    <span className={`inline-flex h-7 items-center rounded-full px-2.5 text-xs font-medium ${
      active ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground"
    }`}>
      {active ? activeText : inactiveText}
    </span>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="break-all text-foreground/80">{value}</span>
    </div>
  );
}

function NumberInput({
  suffix,
  value,
  onChange,
}: {
  suffix?: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-input bg-background px-2">
      <input
        type="number"
        value={value}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-full w-24 bg-transparent text-right text-sm outline-none"
      />
      {suffix ? <span className="ml-1 text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function clampPort(value: number, fallback: number) {
  return clampNumber(value, fallback, 1, 65535);
}
