import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Input } from "@/renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  Segmented,
  SettingsField,
  SettingsSection,
  secondaryButton,
  settingsInput,
} from "../settings-shared";

/** 面板主体：settings 已就绪后由外层传入，避免内部到处判空 */
function GeneralPanelBody({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  // 输入类字段先用本地状态承接，失焦/回车才落盘，避免每次按键都写配置
  const [chatFont, setChatFont] = useState(settings.chatFont);
  const [chatFontSize, setChatFontSize] = useState(settings.chatFontSize);
  const [dataDir, setDataDir] = useState<string | null>(null);

  // 数据目录：打开目录能力当前 IPC 未提供，只读展示
  useEffect(() => {
    void window.polaragent.app
      .getInfo()
      .then((info) => setDataDir(info.dataDir))
      .catch(() => setDataDir(null));
  }, []);

  // 外部（同步/回滚）改变设置时，同步本地编辑值
  useEffect(() => setChatFont(settings.chatFont), [settings.chatFont]);
  useEffect(() => setChatFontSize(settings.chatFontSize), [settings.chatFontSize]);

  const commitChatFont = () => {
    if (chatFont !== settings.chatFont) void update({ chatFont });
  };

  // 滑块拖动过程只更新本地，松开指针或键盘释放时才写入
  const commitChatFontSize = () => {
    if (chatFontSize !== settings.chatFontSize) void update({ chatFontSize });
  };

  const handlePickWorkingDir = async () => {
    const dir = await window.polaragent.dialog
      .pickDirectory(settings.defaultWorkingDir ?? undefined)
      .catch(() => null);
    if (dir) void update({ defaultWorkingDir: dir });
  };

  const handlePickLanguage = (language: "zh-CN" | "en-US") => {
    void update({ language });
    // 界面语言立即切换，与设置落盘并行
    void i18n.changeLanguage(language);
  };

  return (
    <div className="space-y-6">
      <SettingsSection title={t("settings.appearanceSection")}>
        <SettingsField
          label={t("settings.theme")}
          description={t("settings.themeDesc")}
          control={
            <Segmented
              ariaLabel={t("settings.theme")}
              value={settings.theme}
              onChange={(theme) => void update({ theme })}
              options={[
                { value: "light", label: t("app.themeLight") },
                { value: "dark", label: t("app.themeDark") },
                { value: "system", label: t("app.themeSystem") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.density")}
          control={
            <Segmented
              ariaLabel={t("settings.density")}
              value={settings.density}
              onChange={(density) => void update({ density })}
              options={[
                { value: "comfortable", label: t("settings.densityComfortable") },
                { value: "compact", label: t("settings.densityCompact") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.language")}
          description={t("settings.languageDesc")}
          control={
            <Segmented
              ariaLabel={t("settings.language")}
              value={settings.language}
              onChange={handlePickLanguage}
              options={[
                { value: "zh-CN", label: "简体中文" },
                { value: "en-US", label: "English" },
              ]}
            />
          }
        />
      </SettingsSection>

      {/* 对话排版：不设分区标题，保持与设计稿一致的安静行式布局 */}
      <SettingsSection>
        <SettingsField
          label={t("settings.chatFont")}
          description={t("settings.chatFontDesc")}
          htmlFor="settings-chat-font"
          control={
            <Input
              id="settings-chat-font"
              value={chatFont}
              placeholder={t("settings.chatFontDesc")}
              onChange={(e) => setChatFont(e.target.value)}
              onBlur={commitChatFont}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className={cn(settingsInput, "w-56")}
            />
          }
        />
        <SettingsField
          label={t("settings.chatFontSize")}
          htmlFor="settings-chat-font-size"
          control={
            <div className="flex items-center gap-2">
              <input
                id="settings-chat-font-size"
                type="range"
                min={12}
                max={20}
                step={1}
                value={chatFontSize}
                aria-label={t("settings.chatFontSize")}
                onChange={(e) => setChatFontSize(Number(e.target.value))}
                onPointerUp={commitChatFontSize}
                onKeyUp={commitChatFontSize}
                onBlur={commitChatFontSize}
                className="h-1 w-32 cursor-pointer accent-foreground focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none"
              />
              <span className={cn(typePackage, "w-10 shrink-0 text-right text-foreground/40")}>
                {chatFontSize}px
              </span>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection title={t("settings.dataSection")}>
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
        <SettingsField
          label={t("settings.dataDir")}
          description={t("settings.dataDirDesc")}
          control={
            <div className="flex items-center gap-2">
              {/* 路径是唯一信息来源，用 mono 截断展示；无 openPath IPC，按钮保持禁用 */}
              <span
                className={cn(typePackage, "max-w-[240px] truncate text-foreground/40")}
                title={dataDir ?? undefined}
              >
                {dataDir ?? "—"}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={secondaryButton}
                      disabled
                    >
                      {t("settings.openDataDir")}
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{`${t("settings.openDataDir")} · ${t("common.disabled")}`}</TooltipContent>
              </Tooltip>
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}

export function GeneralPanel() {
  const settings = useSettingsStore((s) => s.settings);
  if (!settings) return <PanelLoading />;
  return <GeneralPanelBody settings={settings} />;
}
