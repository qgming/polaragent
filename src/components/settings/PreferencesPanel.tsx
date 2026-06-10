// 偏好设置面板（主题/对话字体/字号 + SkillsMP API Key）
// src/components/settings/PreferencesPanel.tsx

import { useEffect, useState } from "react";
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
  const setAppearance = (updates: Partial<Settings["appearance"]>) =>
    onUpdate({
      appearance: {
        ...settings.appearance,
        ...updates,
      },
    });

  return (
    <section>
      <PageTitle title="偏好设置" description="调整外观、对话与语音输入等个人偏好。" />

      <div className="mt-8 divide-y divide-border rounded-xl border border-border bg-card">
        <SettingRow
          title="主题亮暗"
          description="浅色、深色，或跟随系统。"
          control={
            <SettingDropdown
              value={settings.appearance.theme}
              onChange={(theme) =>
                void setAppearance({
                  theme: theme as Settings["appearance"]["theme"],
                })
              }
              options={[
                { value: "light", label: "亮色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" },
              ]}
            />
          }
        />
        <SettingRow
          title="对话字体"
          description="对话内容使用无衬线、衬线或等宽字体。"
          control={
            <SettingDropdown
              value={settings.appearance.chatFont}
              onChange={(font) =>
                void setAppearance({
                  chatFont: font as Settings["appearance"]["chatFont"],
                })
              }
              options={[
                { value: "sans", label: "无衬线" },
                { value: "serif", label: "衬线" },
                { value: "mono", label: "等宽" },
              ]}
            />
          }
        />
        <SettingRow
          title="对话字号"
          description="调整对话中的文字大小。"
          control={
            <SettingDropdown
              value={settings.appearance.chatFontSize}
              onChange={(size) =>
                void setAppearance({
                  chatFontSize: size as Settings["appearance"]["chatFontSize"],
                })
              }
              options={[
                { value: "small", label: "小" },
                { value: "medium", label: "中" },
                { value: "large", label: "大" },
                { value: "xlarge", label: "特大" },
              ]}
            />
          }
        />
      </div>

      <VoiceInputCard settings={settings} onUpdate={onUpdate} />

      <SkillsApiKeyCard settings={settings} onUpdate={onUpdate} />
    </section>
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
        title="语音识别后自动发送"
        description="语音识别完成后自动发送消息；与口语优化同时开启时，将在文本整理完成后发送。"
        control={
          <Switch
            checked={inputOptimization.autoSend}
            onCheckedChange={(checked) => void update({ autoSend: checked })}
          />
        }
      />
      <SettingRow
        title="语音识别文本优化"
        description="识别完成后调用 AI 对文本进行整理，去除口头语与语气词，使表达更清晰、正式。"
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
          <h3 className="text-sm font-semibold">SkillsMP API Key</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          技能广场来自 SkillsMP。不填也能搜索（匿名额度较低）；填写后可提升每日配额。
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
            保存
          </Button>
        </div>
      </div>
    </div>
  );
}
