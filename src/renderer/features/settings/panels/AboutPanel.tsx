import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import type { AppInfo } from "@/shared/contracts/app";
import { PanelLoading, SettingsField, SettingsSection } from "../settings-shared";

export function AboutPanel() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    void window.oint.app
      .getInfo()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  if (!info) return <PanelLoading />;

  return (
    <div className="space-y-6">
      <SettingsSection>
        <SettingsField
          label={t("settings.aboutName")}
          control={<span className="text-[13.5px]">{info.name ?? ""}</span>}
        />
        <SettingsField
          label={t("settings.aboutVersion")}
          control={<span className={typePackage}>{info.version ?? ""}</span>}
        />
        {/* 内核：pisdk 的两个 pi 包，名称与版本逐行排（版本读不到时留空，不编造） */}
        <SettingsField
          label={t("settings.aboutKernel")}
          control={
            // 包名很长：按数据目录那行的口径限宽截断，鼠标悬停用 title 给全名，
            // 否则窄窗口下会把左侧标签挤到折行（「内核」被拆成两行）
            <div className="flex flex-col items-end gap-0.5">
              {info.kernel.map((dependency) => (
                <span key={dependency.name} className="flex items-baseline gap-2">
                  <span
                    className={cn(typePackage, "max-w-[200px] truncate text-ink-2")}
                    title={dependency.name}
                  >
                    {dependency.name}
                  </span>
                  {dependency.version ? (
                    <span className={cn(typePackage, "shrink-0 text-ink-4")}>
                      {dependency.version}
                    </span>
                  ) : null}
                </span>
              ))}
            </div>
          }
        />
      </SettingsSection>

      <p className="border-border/60 border-t pt-4 text-xs text-ink-4">MIT License</p>
    </div>
  );
}
