import { ExternalLink, FolderOpen, Trash2 } from "lucide-react";
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
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { Settings } from "@/shared/contracts/settings";
import { PanelLoading, SettingsField, SettingsSection, secondaryButton } from "../settings-shared";

/**
 * 「打开目录」按钮的可用性判断：目录选择框只给出绝对路径，但设置里可能存在手填的相对路径。
 * 主进程的 app.openPath 会拒绝非绝对路径（reason: invalid-path），这里提前禁用，
 * 避免点了没反应、看起来像按钮坏了。
 */
const ABSOLUTE_PATH = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/;

function PromptsPanelBody({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  const [templates, setTemplates] = useState<PromptTemplateInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  const workingDir = settings.defaultWorkingDir ?? undefined;

  const refresh = useCallback(async () => {
    setFailed(false);
    setTemplates(null);
    try {
      setTemplates(await window.oint.prompts.list(workingDir));
    } catch {
      setFailed(true);
      setTemplates([]);
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAddDir = async () => {
    const dir = await window.oint.dialog.pickDirectory().catch(() => null);
    // 去重：同一目录只保留一条
    if (dir && !settings.promptTemplateDirs.includes(dir)) {
      void update({ promptTemplateDirs: [...settings.promptTemplateDirs, dir] });
    }
  };

  const handleRemoveDir = (dir: string) => {
    void update({
      promptTemplateDirs: settings.promptTemplateDirs.filter((item) => item !== dir),
    });
  };

  // 打开目录复用主进程的 app.openPath（与「数据」面板同一个入口，会校验绝对路径再交给系统）
  const handleOpenDir = async (dir: string) => {
    const result = await window.oint.app.openPath(dir).catch(() => null);
    if (result === null || !result.ok) {
      console.warn(`打开提示模板目录失败 ${dir}: ${result?.reason ?? "未知原因"}`);
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("settings.promptTemplateDirs")}
        description={t("settings.promptTemplateDirsDesc")}
      >
        {settings.promptTemplateDirs.length === 0 ? (
          <p className="text-[13px] text-foreground/45">{t("common.empty")}</p>
        ) : (
          <div className="space-y-1">
            {settings.promptTemplateDirs.map((dir) => (
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
                  aria-label={t("settings.openPromptDir")}
                  title={t("settings.openPromptDir")}
                  className={cn(
                    ghostButton,
                    "size-6 shrink-0 disabled:pointer-events-none disabled:opacity-40",
                  )}
                  disabled={!ABSOLUTE_PATH.test(dir)}
                  onClick={() => void handleOpenDir(dir)}
                >
                  <ExternalLink className="size-3.5" />
                </button>
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
          label={t("settings.promptTemplateDirs")}
          control={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={secondaryButton}
              onClick={() => void handleAddDir()}
            >
              {t("settings.addPromptDir")}
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("settings.promptTemplatesList")}
        description={t("settings.promptTemplatesDesc")}
      >
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
        ) : templates === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-xl" />
          </div>
        ) : templates.length === 0 ? (
          <p className="rounded-xl border border-border/60 p-4 text-center text-[13px] text-foreground/45">
            {t("settings.promptTemplatesEmpty")}
            <span className="mt-1 block text-xs text-foreground/40">
              {t("settings.promptTemplatesEmptyHint")}
            </span>
          </p>
        ) : (
          <div className="space-y-2">
            {templates.map((template) => (
              <div key={template.name} className="rounded-xl border border-border/60 p-3">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13.5px] font-medium">{template.name}</span>
                  <Badge
                    variant="outline"
                    className={cn(mono, "border-border/60 px-1.5 text-foreground/50")}
                  >
                    {template.source === "global"
                      ? t("settings.skillSourceGlobal")
                      : t("settings.skillSourceProject")}
                  </Badge>
                </div>
                {template.description === "" ? null : (
                  <p className="mt-0.5 line-clamp-2 text-xs text-foreground/45">
                    {template.description}
                  </p>
                )}
                {/* 正文可能很长：只给固定行数的等宽预览并裁掉溢出，不把整段正文铺开 */}
                <p className={cn(mono, "mt-1 line-clamp-4 whitespace-pre-wrap text-foreground/40")}>
                  {template.content}
                </p>
                <p className={cn(mono, "mt-1 truncate text-foreground/35")} title={template.dir}>
                  {template.dir}
                </p>
              </div>
            ))}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

export function PromptsPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <PromptsPanelBody settings={settings} />;
}
