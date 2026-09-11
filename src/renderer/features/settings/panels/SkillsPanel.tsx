import { FolderOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  fieldInteractive,
  ghostButton,
  mono,
} from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillInfo } from "@/shared/contracts/skills";
import { PanelLoading, SettingsField, SettingsSection, secondaryButton } from "../settings-shared";

function SkillsPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [skills, setSkills] = useState<SkillInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  const workingDir = settings.defaultWorkingDir ?? undefined;

  const refresh = useCallback(async () => {
    setFailed(false);
    setSkills(null);
    try {
      setSkills(await window.oint.skills.list(workingDir));
    } catch {
      setFailed(true);
      setSkills([]);
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAddDir = async () => {
    const dir = await window.oint.dialog.pickDirectory().catch(() => null);
    // 去重：同一目录只保留一条
    if (dir && !settings.skillDirs.includes(dir)) {
      void update({ skillDirs: [...settings.skillDirs, dir] });
    }
  };

  const handleRemoveDir = (dir: string) => {
    void update({ skillDirs: settings.skillDirs.filter((item) => item !== dir) });
  };

  const handleToggleSkill = (name: string, enabled: boolean) => {
    const disabled = new Set(settings.disabledSkillNames);
    if (enabled) {
      disabled.delete(name);
    } else {
      disabled.add(name);
    }
    void update({ disabledSkillNames: [...disabled] });
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.skillDirs")} description={t("settings.skillDirsDesc")}>
        {settings.skillDirs.length === 0 ? (
          <p className="text-[13px] text-foreground/45">{t("common.empty")}</p>
        ) : (
          <div className="space-y-1">
            {settings.skillDirs.map((dir) => (
              <div
                key={dir}
                className={cn(
                  fieldInteractive,
                  "flex items-center gap-2 rounded-[10px] px-2.5 py-1.5",
                )}
              >
                <FolderOpen className="size-3.5 shrink-0 text-foreground/40" aria-hidden="true" />
                <span className={cn(typePackage, "min-w-0 flex-1 truncate")} title={dir}>
                  {dir}
                </span>
                <button
                  type="button"
                  aria-label={t("common.delete")}
                  className={cn(ghostButton, "size-6 shrink-0 hover:text-destructive")}
                  onClick={() => handleRemoveDir(dir)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
        <SettingsField
          label={t("settings.skillDirs")}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void handleAddDir()}
            >
              {t("settings.addSkillDir")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.skillsList")} description={t("settings.skillsListDesc")}>
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
        ) : skills === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : skills.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-foreground/45">
            {t("settings.skillsEmpty")}
            <span className="mt-1 block text-xs text-foreground/40">
              {t("settings.skillsEmptyHint")}
            </span>
          </p>
        ) : (
          <div className="space-y-2">
            {skills.map((skill) => {
              // 设置中的禁用名单是唯一事实来源，避免列表快照过期
              const enabled = !settings.disabledSkillNames.includes(skill.name);
              return (
                <div
                  key={skill.filePath}
                  className="flex items-start justify-between gap-3 rounded-xl border border-border/60 p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium">{skill.name}</span>
                      <Badge
                        variant="outline"
                        className={cn(mono, "border-border/60 px-1.5 text-foreground/50")}
                      >
                        {skill.source === "global"
                          ? t("settings.skillSourceGlobal")
                          : t("settings.skillSourceProject")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-foreground/45">
                      {skill.description}
                    </p>
                    <p
                      className={cn(mono, "mt-1 truncate text-foreground/40")}
                      title={skill.filePath}
                    >
                      {skill.filePath}
                    </p>
                  </div>
                  <Switch
                    size="sm"
                    aria-label={enabled ? t("settings.skillEnabled") : t("settings.skillDisabled")}
                    checked={enabled}
                    onCheckedChange={(checked) => handleToggleSkill(skill.name, checked)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

export function SkillsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <SkillsPanelBody settings={settings} />;
}
