// 偏好设置面板（主题/对话字体/字号 + SkillsMP API Key）
// src/components/settings/PreferencesPanel.tsx

import { useEffect, useState } from "react";
import { Check, Eye, EyeOff, KeyRound, Loader2, Save, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Settings } from "@/types/config";
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
      <PageTitle title="偏好设置" description="个性化你的主题与对话外观。" />

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

      <SkillsApiKeyCard settings={settings} onUpdate={onUpdate} />
      <SearxngInstancesCard settings={settings} onUpdate={onUpdate} />
    </section>
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

// SearXNG 搜索实例设置卡片
function SearxngInstancesCard({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const [value, setValue] = useState(settings.searxngInstances ?? "");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  useEffect(() => {
    setValue(settings.searxngInstances ?? "");
  }, [settings.searxngInstances]);

  const handleSave = async () => {
    setSaveState("saving");
    await onUpdate({ searxngInstances: value.trim() });
    setSaveState("saved");
    setTimeout(() => setSaveState("idle"), 1500);
  };

  return (
    <div className="mt-6 rounded-xl border border-border bg-card">
      <div className="px-5 py-5">
        <div className="flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">SearXNG 搜索实例</h3>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          网络搜索通过 SearXNG 实例完成。留空则使用内置公共实例；也可填入你自己的实例（每行一个，或用逗号分隔），更稳定。
        </p>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={"https://searx.be\nhttps://search.inetol.net"}
          className="app-scrollbar mt-4 min-h-[96px] w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-ring"
        />
        <div className="mt-3 flex justify-end">
          <Button
            onClick={() => void handleSave()}
            disabled={saveState === "saving"}
          >
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
