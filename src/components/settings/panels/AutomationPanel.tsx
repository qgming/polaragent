// 自动化：Computer Use + Browser Use
// src/components/settings/panels/AutomationPanel.tsx

import { useTranslation } from "react-i18next";
import type { Settings } from "@/types/config";
import { ComputerUsePanel } from "../ComputerUsePanel";
import { BrowserUsePanel } from "../BrowserUsePanel";
import { SectionHeader } from "./GeneralPanel";

export function AutomationPanel({
  settings,
  onUpdate,
}: {
  settings: Settings;
  onUpdate: (updates: Partial<Settings>) => Promise<void>;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-8">
      <SectionHeader title={t("nav.automation", "自动化")} />
      <ComputerUsePanel settings={settings} onUpdate={onUpdate} embedded />
      <BrowserUsePanel settings={settings} onUpdate={onUpdate} embedded />
    </div>
  );
}
