// 偏好设置面板（主题/对话字体/字号）
// src/components/settings/PreferencesPanel.tsx

import type { Settings } from "@/types/config";
import { PageTitle, SettingDropdown, SettingRow } from "./settings-shared";

export function PreferencesPanel({
  settings,
  onUpdate,
  embedded,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
  embedded?: boolean;
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
      {!embedded ? (
        <PageTitle title="外观" description="主题、对话字体与字号" />
      ) : null}

      <div className={embedded ? "divide-y divide-border/50 rounded-xl border border-border/60 bg-card" : "mt-8 divide-y divide-border/50 rounded-xl border border-border/60 bg-card"}>
        <SettingRow
          title="主题"
          description="选择界面配色"
          control={
            <SettingDropdown
              value={settings.appearance.theme}
              onChange={(theme) =>
                void setAppearance({
                  theme: theme as Settings["appearance"]["theme"],
                })
              }
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" },
              ]}
            />
          }
        />
        <SettingRow
          title="对话字体"
          description="对话内容的字体族"
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
          description="对话内容的文字大小"
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
    </section>
  );
}
