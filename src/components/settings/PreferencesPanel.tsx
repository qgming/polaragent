// 偏好设置面板（主题/对话字体/字号 + 语言）
// src/components/settings/PreferencesPanel.tsx

import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import type { Settings } from "@/types/config";
import { defaultSettings } from "@/config/defaults";
import { PageTitle, SettingDropdown, SettingRow } from "./settings-shared";

export function PreferencesPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");

  const setAppearance = (updates: Partial<Settings["appearance"]>) =>
    onUpdate({
      appearance: {
        ...settings.appearance,
        ...updates,
      },
    });

  return (
    <section>
      <PageTitle title={t("preferences.title")} description={t("preferences.description")} />

      <div className="mt-8 divide-y divide-border rounded-xl border border-border bg-card">
        <SettingRow
          title={t("preferences.language")}
          description={t("preferences.languageDesc")}
          control={
            <SettingDropdown
              value={settings.appearance.language}
              onChange={(lang) =>
                void setAppearance({
                  language: lang as Settings["appearance"]["language"],
                })
              }
              options={[
                { value: "system", label: t("preferences.followSystem") },
                { value: "zh-CN", label: t("preferences.simplifiedChinese") },
                { value: "en-US", label: t("preferences.english") },
              ]}
            />
          }
        />
        <SettingRow
          title={t("preferences.theme")}
          description={t("preferences.themeDesc")}
          control={
            <SettingDropdown
              value={settings.appearance.theme}
              onChange={(theme) =>
                void setAppearance({
                  theme: theme as Settings["appearance"]["theme"],
                })
              }
              options={[
                { value: "light", label: t("preferences.light") },
                { value: "dark", label: t("preferences.dark") },
                { value: "system", label: t("preferences.followSystem") },
              ]}
            />
          }
        />
        <SettingRow
          title={t("preferences.chatFont")}
          description={t("preferences.chatFontDesc")}
          control={
            <SettingDropdown
              value={settings.appearance.chatFont}
              onChange={(font) =>
                void setAppearance({
                  chatFont: font as Settings["appearance"]["chatFont"],
                })
              }
              options={[
                { value: "sans", label: t("preferences.sans") },
                { value: "serif", label: t("preferences.serif") },
                { value: "mono", label: t("preferences.mono") },
              ]}
            />
          }
        />
        <SettingRow
          title={t("preferences.chatFontSize")}
          description={t("preferences.chatFontSizeDesc")}
          control={
            <SettingDropdown
              value={settings.appearance.chatFontSize}
              onChange={(size) =>
                void setAppearance({
                  chatFontSize: size as Settings["appearance"]["chatFontSize"],
                })
              }
              options={[
                { value: "small", label: t("preferences.small") },
                { value: "medium", label: t("preferences.medium") },
                { value: "large", label: t("preferences.large") },
                { value: "xlarge", label: t("preferences.xlarge") },
              ]}
            />
          }
        />
      </div>

      <WindowBehaviorCard settings={settings} onUpdate={onUpdate} />

      <VoiceInputCard settings={settings} onUpdate={onUpdate} />
    </section>
  );
}

// 窗口行为卡片（关闭到托盘 / 启动时隐藏到托盘）
function WindowBehaviorCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");

  const setWindow = (updates: Partial<Settings["window"]>) =>
    onUpdate({
      window: {
        ...settings.window,
        ...updates,
      },
    });

  return (
    <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card">
      <SettingRow
        title={t("preferences.closeToTray")}
        description={t("preferences.closeToTrayDesc")}
        control={
          <Switch
            checked={settings.window.closeToTray}
            onCheckedChange={(checked) => void setWindow({ closeToTray: checked })}
          />
        }
      />
      <SettingRow
        title={t("preferences.startInSystemTray")}
        description={t("preferences.startInSystemTrayDesc")}
        control={
          <Switch
            checked={settings.window.startInSystemTray}
            onCheckedChange={(checked) => void setWindow({ startInSystemTray: checked })}
          />
        }
      />
    </div>
  );
}

// 语音输入优化卡片（自动发送 / 口语优化），原属音频设置，移入偏好设置统一管理
function VoiceInputCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");

  const audioDefaults = () => settings.audio ?? defaultSettings.audio!;
  const inputOptimization =
    settings.audio?.inputOptimization ??
    defaultSettings.audio?.inputOptimization ?? { autoSend: false, refineText: false };

  // 改动即写入，失败时由调用方 store 兜底（与原音频面板逻辑一致）
  const update = (patch: Partial<{ autoSend: boolean; refineText: boolean }>) => {
    const currentAudio = audioDefaults();
    return onUpdate({
      audio: {
        ...currentAudio,
        inputOptimization: {
          ...currentAudio.inputOptimization,
          ...patch,
        },
      },
    });
  };

  return (
    <div className="mt-6 divide-y divide-border rounded-xl border border-border bg-card">
      <SettingRow
        title={t("preferences.voiceAutoSend")}
        description={t("preferences.voiceAutoSendDesc")}
        control={
          <Switch
            checked={inputOptimization.autoSend}
            onCheckedChange={(checked) => void update({ autoSend: checked })}
          />
        }
      />
      <SettingRow
        title={t("preferences.voiceRefineText")}
        description={t("preferences.voiceRefineTextDesc")}
        control={
          <Switch
            checked={inputOptimization.refineText}
            onCheckedChange={(checked) => void update({ refineText: checked })}
          />
        }
      />
    </div>
  );
}
