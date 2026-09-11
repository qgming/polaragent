import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghostButton } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import type { AppInfo } from "@/shared/contracts/app";
import { PanelLoading, SettingsField, SettingsSection } from "../settings-shared";

export function AboutPanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.polaragent.app
      .getInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  // 复制反馈 1.5s 后自动复位
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopyDataDir = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.dataDir);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (!info) return <PanelLoading />;

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SettingsField
          label={t("app.name")}
          control={<span className="text-[13.5px]">{info.name}</span>}
        />
        <SettingsField
          label={t("settings.aboutVersion")}
          control={<span className={typePackage}>{info.version}</span>}
        />
        <SettingsField
          label={t("settings.aboutPlatform")}
          control={<span className={typePackage}>{info.platform}</span>}
        />
        <SettingsField
          label={t("settings.dataDir")}
          control={
            <div className="flex items-center gap-2">
              <span
                className={cn(typePackage, "max-w-[280px] truncate text-foreground/40")}
                title={info.dataDir}
              >
                {info.dataDir}
              </span>
              <button
                type="button"
                aria-label={t("common.copy")}
                className={cn(ghostButton, "size-7 shrink-0")}
                onClick={() => void handleCopyDataDir()}
              >
                {copied ? (
                  <Check className="size-3.5 text-foreground/70" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </button>
            </div>
          }
        />
      </SettingsSection>

      <p className="border-border/60 border-t pt-4 text-xs text-foreground/40">MIT License</p>
    </div>
  );
}
