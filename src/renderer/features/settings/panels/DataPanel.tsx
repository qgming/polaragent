import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ghostButton } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { OpenDirButton, PanelLoading, SettingsField, SettingsSection } from "../settings-shared";

/**
 * 数据面板：只展示数据目录的位置（复制 / 打开）。
 *
 * 没有「默认工作目录」这类可改项：会话目录跟随各自绑定的项目走，
 * 全局资源固定在数据目录的 skills/ prompts/ subagents/ 里，都不需要用户在这里配置。
 */
function DataPanelBody() {
  const { t } = useTranslation();
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
      </SettingsSection>

      <p className="text-xs text-ink-4">{t("settings.dataDirHint")}</p>
    </div>
  );
}

export function DataPanel() {
  // 与其余面板同一个加载口径：设置就绪前先给占位，避免面板闪一下
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <DataPanelBody />;
}
