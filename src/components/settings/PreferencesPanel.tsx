// 偏好设置面板（主题/对话字体/字号 + 语言 + SkillsMP API Key）
// src/components/settings/PreferencesPanel.tsx

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Eye, EyeOff, KeyRound, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
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

      <SkillsApiKeyCard settings={settings} onUpdate={onUpdate} />
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

// SkillsMP 技能广场 API Key 设置卡片
function SkillsApiKeyCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");

  const [value, setValue] = useState(settings.skillsApiKey ?? "");
  const [show, setShow] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  useEffect(() => {
    setValue(settings.skillsApiKey ?? "");
  }, [settings.skillsApiKey]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({ skillsApiKey: value.trim() });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="mt-6 rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">{t("preferences.skillsApiKeyTitle")}</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {t("preferences.skillsApiKeyDesc")}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <div className="relative flex-1">
            <input
              type={show ? "text" : "password"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="sk_live_..."
              className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
            />
            <button
              type="button"
              onClick={() => setShow((current) => !current)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          <Button onClick={() => void handleSave()} disabled={saveState === "saving"}>
            {saveState === "saving" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : saveState === "saved" ? (
              <Check className="size-4" />
            ) : (
              <Save className="size-4" />
            )}
            {t("common:save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
