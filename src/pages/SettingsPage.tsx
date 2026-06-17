// Settings 页面壳 - 左侧导航 + 右侧面板编排
// src/pages/SettingsPage.tsx

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, AudioLines, Bot, Brain, Database, Globe, Image, Info, Monitor, Search, Settings2 } from "lucide-react";
import { initializeAiRuntime } from "@/lib/app-init";
import { useConfigStore } from "@/stores/config-store";
import { cn } from "@/lib/utils";
import { ModelPanel } from "@/components/settings/ModelPanel";
import { PreferencesPanel } from "@/components/settings/PreferencesPanel";
import { ImageGenerationPanel } from "@/components/settings/ImageGenerationPanel";
import { AudioPanel } from "@/components/settings/AudioPanel";
import { WebSearchPanel } from "@/components/settings/WebSearchPanel";
import { KnowledgePanel } from "@/components/settings/KnowledgePanel";
import { MemoryPanel } from "@/components/settings/MemoryPanel";
import { AdvancedPanel } from "@/components/settings/AdvancedPanel";
import { ComputerUsePanel } from "@/components/settings/ComputerUsePanel";
import { BrowserUsePanel } from "@/components/settings/BrowserUsePanel";
import { AboutPanel } from "@/components/settings/AboutPanel";

export type SettingsSection = "preferences" | "models" | "imageGeneration" | "audio" | "webSearch" | "knowledge" | "memory" | "data" | "computerUse" | "browserUse" | "about";

// 设置项定义（标签由 i18n 驱动，此处只放 id + icon）
const navItems: Array<{ id: SettingsSection; icon: typeof Settings2 }> = [
  { id: "preferences", icon: Settings2 },
  { id: "models", icon: Bot },
  { id: "imageGeneration", icon: Image },
  { id: "audio", icon: AudioLines },
  { id: "webSearch", icon: Search },
  { id: "knowledge", icon: Database },
  { id: "memory", icon: Brain },
  { id: "data", icon: Database },
  { id: "computerUse", icon: Monitor },
  { id: "browserUse", icon: Globe },
  { id: "about", icon: Info },
];

// 支持的语言标题 i18n key 映射
const navLabelKey: Record<SettingsSection, string> = {
  preferences: "settings:nav.preferences",
  models: "settings:nav.models",
  imageGeneration: "settings:nav.image",
  audio: "settings:nav.audio",
  webSearch: "settings:nav.webSearch",
  knowledge: "settings:nav.knowledge",
  memory: "settings:nav.memory",
  data: "settings:nav.data",
  computerUse: "Computer Use",
  browserUse: "Browser Use",
  about: "settings:nav.about",
};

// 导航分组
const navGroupIds: Array<{ titleKey: string; items: SettingsSection[] }> = [
  { titleKey: "settings:nav.general", items: ["preferences", "models", "imageGeneration", "audio", "webSearch", "knowledge", "memory"] },
  { titleKey: "settings:nav.advanced", items: ["data", "computerUse", "browserUse"] },
  { titleKey: "settings:nav.aboutGroup", items: ["about"] },
];

export function SettingsPage({
  initialSection = "preferences",
  onBack,
}: {
  initialSection?: SettingsSection;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const providers = useConfigStore((state) => state.providers);
  const settings = useConfigStore((state) => state.settings);
  const updateSettings = useConfigStore((state) => state.updateSettings);
  const updateProvider = useConfigStore((state) => state.updateProvider);
  const addProvider = useConfigStore((state) => state.addProvider);
  const removeProvider = useConfigStore((state) => state.removeProvider);
  const setDefaultModel = useConfigStore((state) => state.setDefaultModel);
  const [activeSection, setActiveSection] =
    useState<SettingsSection>(initialSection);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  return (
    <div className="flex h-full min-w-0 bg-background">
      <aside className="flex h-full min-h-0 w-[220px] shrink-0 flex-col border-r border-border bg-background px-3 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-6 flex shrink-0 items-center gap-2 px-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("settings:nav.backToApp")}
        </button>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto pr-1">
          {navGroupIds.map((group, index) => (
            <div key={group.titleKey} className={index > 0 ? "mt-6" : undefined}>
              <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">
                {t(group.titleKey)}
              </p>
              <nav className="space-y-1">
                {group.items.map((itemId) => {
                  const item = navItems.find((n) => n.id === itemId)!;
                  const label = navLabelKey[itemId].includes(":") ? t(navLabelKey[itemId]) : navLabelKey[itemId];
                  return (
                    <NavButton
                      key={item.id}
                      item={{ ...item, label }}
                      active={activeSection === item.id}
                      onClick={() => setActiveSection(item.id)}
                    />
                  );
                })}
              </nav>
            </div>
          ))}
        </div>
      </aside>

      <main className="app-scrollbar min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-8 py-14">
          {activeSection === "preferences" ? (
            <PreferencesPanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "models" ? (
            <ModelPanel
              providers={providers}
              onAddProvider={async (provider) => {
                await addProvider(provider);
                initializeAiRuntime();
              }}
              onUpdateProvider={async (id, updates) => {
                await updateProvider(id, updates);
                initializeAiRuntime();
              }}
              onRemoveProvider={async (id) => {
                await removeProvider(id);
                initializeAiRuntime();
              }}
              onSetDefaultModel={async (providerId, modelId) => {
                await setDefaultModel(providerId, modelId);
                initializeAiRuntime();
              }}
            />
          ) : null}
          {activeSection === "webSearch" ? (
            <WebSearchPanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "imageGeneration" ? (
            <ImageGenerationPanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "audio" ? (
            <AudioPanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "knowledge" ? (
            <KnowledgePanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "memory" ? (
            <MemoryPanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "data" ? <AdvancedPanel /> : null}
          {activeSection === "computerUse" ? (
            <ComputerUsePanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "browserUse" ? (
            <BrowserUsePanel settings={settings} onUpdate={updateSettings} />
          ) : null}
          {activeSection === "about" ? <AboutPanel /> : null}
        </div>
      </main>
    </div>
  );
}

// 左侧导航按钮
function NavButton({
  item,
  active,
  onClick,
}: {
  item: { id: SettingsSection; label: string; icon: typeof Settings2 };
  active: boolean;
  onClick: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
        active
          ? "bg-muted text-foreground"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
    </button>
  );
}
