// Computer Use 设置面板
// src/components/settings/ComputerUsePanel.tsx

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Activity, CheckCircle2, Loader2, Monitor, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { AutomationConfig, Settings } from "@/types/config";
import { PageTitle, SettingRow } from "./settings-shared";
import { clampNumber } from "@/lib/utils";

type ComputerHealth = Awaited<ReturnType<typeof window.polaragent.computeruse.health>>;

const DEFAULT_COMPUTER_USE = {
  persistentWorker: true,
  defaultMaxDepth: 5,
  defaultMaxNodes: 250,
  includeScreenshotByDefault: true,
  screenshotMode: "path" as const,
  restoreClipboard: true,
  actionTimeoutMs: 60000,
};

export function ComputerUsePanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  const computerUse = useMemo(
    () => ({
      ...DEFAULT_COMPUTER_USE,
      ...settings.automation?.computerUse,
    }),
    [settings.automation],
  );

  const [draft, setDraft] = useState(computerUse);
  const [health, setHealth] = useState<ComputerHealth | null>(null);
  const [workerStatus, setWorkerStatus] = useState<Awaited<ReturnType<typeof window.polaragent.computeruse.workerStatus>> | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(computerUse);
  }, [computerUse]);

  useEffect(() => {
    void checkHealth();
    void refreshWorkerStatus();
  }, []);

  async function checkHealth() {
    try {
      setHealth(await window.polaragent.computeruse.health());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshWorkerStatus() {
    try {
      setWorkerStatus(await window.polaragent.computeruse.workerStatus());
    } catch (_) {}
  }

  async function save() {
    setSaving(true);
    setMessage(null);
    const nextAutomation: AutomationConfig = {
      ...settings.automation,
      browserUse: {
        wsPort: 18765,
        apiPort: 18767,
        enableHttpApi: false,
        actionTimeoutMs: 30000,
        waitAfterActionMs: 300,
        verboseLogs: false,
        ...settings.automation?.browserUse,
      },
      computerUse: {
        persistentWorker: true, // 始终启用以获得更好性能
        defaultMaxDepth: clampNumber(draft.defaultMaxDepth, 5, 0, 12),
        defaultMaxNodes: 250, // 使用固定默认值
        includeScreenshotByDefault: draft.includeScreenshotByDefault,
        screenshotMode: "path", // 始终使用轻量模式
        restoreClipboard: draft.restoreClipboard,
        actionTimeoutMs: clampNumber(draft.actionTimeoutMs, 60000, 1000, 180000),
      },
    };
    try {
      await onUpdate({ automation: nextAutomation });
      setWorkerStatus(await window.polaragent.computeruse.configure({
        persistentWorker: nextAutomation.computerUse.persistentWorker,
        actionTimeoutMs: nextAutomation.computerUse.actionTimeoutMs,
      }));
      setMessage(t("computerUse.saved"));
    } catch (error) {
      setMessage(t("computerUse.saveFailed", { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setSaving(false);
    }
  }

  const healthy = Boolean(health?.ok);

  return (
    <section>
      <PageTitle
        title="Computer Use"
        description={t("computerUse.description")}
      />

      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Monitor className="size-4 text-foreground" />
              <h2 className="text-sm font-semibold">Computer Use</h2>
            </div>
            <StatusPill active={healthy} activeText={t("computerUse.available")} inactiveText={t("computerUse.checkPending")} />
          </div>
        </div>

        <div className="grid gap-4 px-5 py-5 md:grid-cols-2">
          <Metric icon={CheckCircle2} label="UI Automation" value={healthy ? t("computerUse.available") : t("computerUse.unknown")} />
          <Metric icon={Activity} label="Worker" value={workerStatus?.running ? t("computerUse.workerRunning") : draft.persistentWorker ? t("computerUse.workerPending") : t("computerUse.workerOff")} />
        </div>

        <div className="border-t border-border">
          <SettingRow
            title={t("computerUse.defaultDepth")}
            description={t("computerUse.defaultDepthDesc")}
            control={
              <NumberInput
                value={draft.defaultMaxDepth}
                onChange={(value) => setDraft({ ...draft, defaultMaxDepth: value })}
              />
            }
          />
          <SettingRow
            title={t("computerUse.includeScreenshot")}
            description={t("computerUse.includeScreenshotDesc")}
            control={
              <Switch
                checked={draft.includeScreenshotByDefault}
                onCheckedChange={(checked) => setDraft({ ...draft, includeScreenshotByDefault: checked })}
              />
            }
          />
          <SettingRow
            title={t("computerUse.restoreClipboard")}
            description={t("computerUse.restoreClipboardDesc")}
            control={
              <Switch
                checked={draft.restoreClipboard}
                onCheckedChange={(checked) => setDraft({ ...draft, restoreClipboard: checked })}
              />
            }
          />
          <SettingRow
            title={t("computerUse.actionTimeout")}
            description={t("computerUse.actionTimeoutDesc")}
            control={
              <NumberInput
                suffix="ms"
                value={draft.actionTimeoutMs}
                onChange={(value) => setDraft({ ...draft, actionTimeoutMs: value })}
              />
            }
          />
        </div>

        <div className="border-t border-border px-5 py-4">
          <div className="grid gap-2 text-xs text-muted-foreground">
            <InfoLine label={t("computerUse.status")} value={workerStatus?.busy ? t("computerUse.busy") : workerStatus?.running ? t("computerUse.idle") : t("computerUse.notStarted")} />
          </div>
          {message ? <p className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {t("computerUse.saveDefaults")}
            </Button>
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
