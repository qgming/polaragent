import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { cn } from "@/renderer/lib/utils";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import {
  PanelLoading,
  SELECT_NONE,
  Segmented,
  SettingsField,
  SettingsSection,
  SettingsSelect,
} from "../settings-shared";

/** 面板主体：settings 已就绪后由外层传入，避免内部到处判空 */
function GeneralPanelBody({ settings }: { settings: Settings }) {
  const { t, i18n } = useTranslation();
  const update = useSettingsStore((s) => s.update);
  // 滑块拖动过程只更新本地，松开指针或键盘释放时才落盘
  const [chatFontSize, setChatFontSize] = useState(settings.chatFontSize);

  // 外部（同步/回滚）改变设置时，同步本地编辑值
  useEffect(() => setChatFontSize(settings.chatFontSize), [settings.chatFontSize]);

  // 滑块拖动过程只更新本地，松开指针或键盘释放时才写入
  const commitChatFontSize = () => {
    if (chatFontSize !== settings.chatFontSize) void update({ chatFontSize });
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
          description={t("settings.densityDesc")}
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

      {/* 对话排版：不设分区标题，保持安静的行式布局 */}
      <SettingsSection>
        <SettingsField
          label={t("settings.chatFont")}
          description={t("settings.chatFontDesc")}
          control={
            /*
              原来是一个自由文本输入框，要用户自己敲字体名，留空才回落到默认 ——
              基本没人用，等于一个死设置。改成字体栈下拉：值直接写 CSS 变量引用
              （自定义属性的间接引用会在使用处解析，因此仍然跟随主题令牌），
              空串仍然表示「跟随界面」；Radix Select 不接受空串值，用 SELECT_NONE 哨兵顶上。
              下拉没有「失焦提交」这一步，所以直接落盘（store 是乐观更新）。
            */
            <SettingsSelect
              ariaLabel={t("settings.chatFont")}
              className="w-32"
              value={settings.chatFont === "" ? SELECT_NONE : settings.chatFont}
              onChange={(value) => void update({ chatFont: value === SELECT_NONE ? "" : value })}
              items={[
                { value: SELECT_NONE, label: t("settings.chatFontDefault") },
                { value: "var(--font-sans)", label: t("settings.chatFontSans") },
                { value: "var(--font-display)", label: t("settings.chatFontSerif") },
                { value: "var(--font-mono)", label: t("settings.chatFontMono") },
              ]}
            />
          }
        />
        <SettingsField
          label={t("settings.chatFontSize")}
          description={t("settings.chatFontSizeDesc")}
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
              <span className={cn(typePackage, "w-10 shrink-0 text-right text-ink-4")}>
                {chatFontSize}px
              </span>
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
