// 通用设置：外观 + 数据目录
// src/components/settings/panels/GeneralPanel.tsx

import type { Settings } from "@/types/config";
import { PreferencesPanel } from "../PreferencesPanel";
import { AdvancedPanel } from "../AdvancedPanel";

export function GeneralPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  return (
    <div className="space-y-8">
      <SectionHeader title="通用" />
      <PreferencesPanel settings={settings} onUpdate={onUpdate} embedded />
      <AdvancedPanel embedded />
    </div>
  );
}

export function SectionHeader({ title }: { title: string }) {
  return (
    <h2 className="text-[22px] font-semibold tracking-tight text-foreground">{title}</h2>
  );
}
