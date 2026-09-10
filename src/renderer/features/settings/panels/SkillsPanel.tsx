import { FolderOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/renderer/components/ui/badge";
import { Button } from "@/renderer/components/ui/button";
import { Skeleton } from "@/renderer/components/ui/skeleton";
import { Switch } from "@/renderer/components/ui/switch";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillInfo } from "@/shared/contracts/skills";
import { PanelLoading, SettingsField, SettingsSection } from "../settings-shared";

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
      setSkills(await window.polaragent.skills.list(workingDir));
    } catch {
      setFailed(true);
      setSkills([]);
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAddDir = async () => {
    const dir = await window.polaragent.dialog.pickDirectory().catch(() => null);
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
          <p className="text-xs text-muted-foreground">{t("common.empty")}</p>
        ) : (
          <div className="space-y-1">
            {settings.skillDirs.map((dir) => (
              <div
                key={dir}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <FolderOpen
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={dir}>
                  {dir}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t("common.delete")}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => handleRemoveDir(dir)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
        <SettingsField
          label={t("settings.skillDirs")}
          control={
            <Button type="button" variant="outline" size="sm" onClick={() => void handleAddDir()}>
              {t("settings.addSkillDir")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.skillsList")} description={t("settings.skillsListDesc")}>
        {failed ? (
          <div className="flex items-center gap-2">
            <p className="text-sm text-destructive">{t("errors.loadFailed")}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
              {t("common.retry")}
            </Button>
          </div>
        ) : skills === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : skills.length === 0 ? (
          <p className="rounded-lg border border-border p-4 text-center text-sm text-muted-foreground">
            {t("settings.skillsEmpty")}
            <span className="mt-1 block text-xs">{t("settings.skillsEmptyHint")}</span>
          </p>
        ) : (
          <div className="space-y-2">
            {skills.map((skill) => {
              // 设置中的禁用名单是唯一事实来源，避免列表快照过期
              const enabled = !settings.disabledSkillNames.includes(skill.name);
              return (
                <div
                  key={skill.filePath}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{skill.name}</span>
                      <Badge variant="outline" className="rounded-sm text-[11px]">
                        {skill.source === "global"
                          ? t("settings.skillSourceGlobal")
                          : t("settings.skillSourceProject")}
                      </Badge>
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                    <p
                      className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
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
