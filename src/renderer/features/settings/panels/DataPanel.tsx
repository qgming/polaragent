import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghostButton } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  SettingsField,
  SettingsSection,
  secondaryButton,
  settingsInput,
} from "../settings-shared";

/**
 * 「打开」按钮：走主进程的 app.openPath（那里会校验绝对路径再交给系统）。
 * 失败原因挂在该按钮的 tooltip 上，不静默吞掉 —— 打开失败通常意味着目录被删或被占用。
 */
function OpenDirButton({ target, label }: { target: string | null; label: string }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState<string | null>(null);

  const handleClick = async () => {
    if (target === null || target === "") return;
    const result = await window.oint.app.openPath(target).catch(() => null);
    setReason(result === null || !result.ok ? (result?.reason ?? t("errors.generic")) : null);
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={secondaryButton}
            disabled={target === null || target === ""}
            onClick={() => void handleClick()}
          >
            {label}
          </Button>
        </span>
      </TooltipTrigger>
      {reason !== null ? (
        <TooltipContent>{`${t("settings.openFailed")}：${reason}`}</TooltipContent>
      ) : null}
    </Tooltip>
  );
}

/** 面板主体：settings 已就绪后由外层传入，避免内部到处判空 */
function DataPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 数据目录：读取一次用于展示；「打开」走 app.openPath
  useEffect(() => {
    void window.oint.app
      .getInfo()
      .then((info) => setDataDir(info.dataDir))
      .catch(() => setDataDir(null));
  }, []);

  // 复制反馈 1.5s 后自动复位
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopyDataDir = async () => {
    if (dataDir === null || dataDir === "") return;
    try {
      await navigator.clipboard.writeText(dataDir);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handlePickWorkingDir = async () => {
    const dir = await window.oint.dialog
      .pickDirectory(settings.defaultWorkingDir ?? undefined)
      .catch(() => null);
    if (dir) void update({ defaultWorkingDir: dir });
  };

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SettingsField
          label={t("settings.dataDir")}
          description={t("settings.dataDirDesc")}
          control={
            <div className="flex items-center gap-2">
              {/* 路径是唯一信息来源：mono 截断展示，完整路径在 title 里 */}
              <span
                className={cn(typePackage, "max-w-[240px] truncate text-ink-4")}
                title={dataDir ?? undefined}
              >
                {dataDir ?? "—"}
              </span>
              <button
                type="button"
                aria-label={t("common.copy")}
                className={cn(ghostButton, "size-7 shrink-0")}
                onClick={() => void handleCopyDataDir()}
              >
                {copied ? <Check className="size-3.5 text-ink-2" /> : <Copy className="size-3.5" />}
              </button>
              <OpenDirButton target={dataDir} label={t("settings.openDataDir")} />
            </div>
          }
        />
        <SettingsField
          label={t("settings.workingDir")}
          description={t("settings.workingDirDesc")}
          htmlFor="settings-working-dir"
          control={
            <div className="flex items-center gap-2">
              <Input
                id="settings-working-dir"
                readOnly
                value={settings.defaultWorkingDir ?? ""}
                placeholder="—"
                className={cn(settingsInput, "w-56 font-mono")}
              />
              <OpenDirButton target={settings.defaultWorkingDir} label={t("settings.openFolder")} />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={secondaryButton}
                onClick={() => void handlePickWorkingDir()}
              >
                {t("settings.pickDirectory")}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <p className="text-xs text-ink-4">{t("settings.dataDirHint")}</p>
    </div>
  );
}

export function DataPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <DataPanelBody settings={settings} />;
}
