import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
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
          control={<span className="text-sm">{info.name}</span>}
        />
        <SettingsField
          label={t("settings.aboutVersion")}
          control={<span className="font-mono text-sm">{info.version}</span>}
        />
        <SettingsField
          label={t("settings.aboutPlatform")}
          control={<span className="font-mono text-sm">{info.platform}</span>}
        />
        <SettingsField
          label={t("settings.dataDir")}
          control={
            <div className="flex items-center gap-2">
              <span
                className="max-w-[280px] truncate font-mono text-xs text-muted-foreground"
                title={info.dataDir}
              >
                {info.dataDir}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("common.copy")}
                onClick={() => void handleCopyDataDir()}
              >
                {copied ? (
                  <Check className="size-4 text-brand-text" />
                ) : (
                  <Copy className="size-4" />
                )}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <p className="border-border border-t pt-4 text-xs text-muted-foreground">MIT License</p>
    </div>
  );
}
