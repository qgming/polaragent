// Browser Use 设置面板
// src/components/settings/BrowserUsePanel.tsx

import { useEffect, useMemo, useState } from "react";
import { Activity, Bug, Globe, Loader2, Save, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutomationConfig, Settings } from "@/types/config";
import { PageTitle, SettingRow } from "./settings-shared";

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
      setMessage("Browser Use 设置已保存并应用。");
    } catch (error) {
      setMessage(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setSaving(false);
    }
  }

  const connected = Boolean(status?.connected);
  const tabCount = status?.tabs?.length ?? 0;

  return (
    <section>
      <PageTitle
        title="Browser Use"
        description="通过内置 Chrome 插件控制真实浏览器会话，保留登录态和 Cookie。"
      />

      <div className="mt-8 rounded-xl border border-border bg-card">
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-foreground" />
              <h2 className="text-sm font-semibold">Browser Use</h2>
            </div>
            <StatusPill active={connected} activeText="已连接" inactiveText="未连接" />
          </div>
        </div>

        <div className="grid gap-4 px-5 py-5 md:grid-cols-3">
          <Metric icon={Server} label="WebSocket 端口" value={String(status?.ports.extension ?? draft.wsPort)} />
          <Metric icon={Activity} label="可操作标签页" value={`${tabCount} 个`} />
          <Metric icon={Bug} label="队列中的任务" value={String(status?.pendingRequests ?? 0)} />
        </div>

        <div className="border-t border-border">
          <SettingRow
            title="WebSocket 端口"
            description="插件连接 PolarAgent 的本地端口。"
            control={
              <NumberInput
                value={draft.wsPort}
                onChange={(value) => setDraft({ ...draft, wsPort: value })}
              />
            }
          />
          <SettingRow
            title="动作超时"
            description="单次浏览器动作等待扩展响应的最长时间。"
            control={
              <NumberInput
                suffix="ms"
                value={draft.actionTimeoutMs}
                onChange={(value) => setDraft({ ...draft, actionTimeoutMs: value })}
              />
            }
          />
          <SettingRow
            title="动作后等待"
            description="点击或填充后等待页面微任务、动画与导航启动。"
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
            <InfoLine label="Profile" value={status?.extension?.profileLabel || status?.extension?.profileId || "未连接"} />
            <InfoLine label="最后错误" value={status?.lastError || "无"} />
          </div>
          {message ? <p className="mt-3 text-xs text-muted-foreground">{message}</p> : null}
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存并应用
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

function clampPort(value: number, fallback: number) {
  return clampNumber(value, fallback, 1, 65535);
}

function clampNumber(value: number, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}
