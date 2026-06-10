// Settings 页面壳 - 左侧导航 + 右侧面板编排
// src/pages/SettingsPage.tsx

import { useEffect, useState } from "react";
import { ArrowLeft, AudioLines, Bot, Database, Image, Info, Search, Settings2 } from "lucide-react";
import { initializeAiRuntime } from "@/lib/app-init";
import { useConfigStore } from "@/stores/config-store";
import { cn } from "@/lib/utils";
import { ModelPanel } from "@/components/settings/ModelPanel";
import { PreferencesPanel } from "@/components/settings/PreferencesPanel";
import { ImageGenerationPanel } from "@/components/settings/ImageGenerationPanel";
import { AudioPanel } from "@/components/settings/AudioPanel";
import { WebSearchPanel } from "@/components/settings/WebSearchPanel";
import { KnowledgePanel } from "@/components/settings/KnowledgePanel";
import { AdvancedPanel } from "@/components/settings/AdvancedPanel";
import { AboutPanel } from "@/components/settings/AboutPanel";

export type SettingsSection = "preferences" | "models" | "imageGeneration" | "audio" | "webSearch" | "knowledge" | "data" | "about";

// 左侧导航按分组组织（通用 / 高级）
const navGroups: Array<{
  title: string;
  items: Array<{ id: SettingsSection; label: string; icon: typeof Settings2 }>;
}> = [
  {
    title: "通用",
    items: [
      { id: "preferences", label: "偏好设置", icon: Settings2 },
      { id: "models", label: "模型设置", icon: Bot },
      { id: "imageGeneration", label: "图片设置", icon: Image },
      { id: "audio", label: "音频设置", icon: AudioLines },
      { id: "webSearch", label: "网络搜索", icon: Search },
      { id: "knowledge", label: "嵌入配置", icon: Database },
    ],
  },
  {
    title: "高级",
    items: [{ id: "data", label: "数据管理", icon: Database }],
  },
  {
    title: "关于",
    items: [{ id: "about", label: "关于软件", icon: Info }],
  },
];

export function SettingsPage({
  initialSection = "preferences",
  onBack,
}: {
  initialSection?: SettingsSection;
  onBack: () => void;
}) {
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
      <aside className="w-[220px] shrink-0 border-r border-border bg-background px-3 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-8 flex items-center gap-2 px-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          返回应用
        </button>

        {navGroups.map((group, index) => (
          <div key={group.title} className={index > 0 ? "mt-6" : undefined}>
            <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">
              {group.title}
            </p>
            <nav className="space-y-1">
              {group.items.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  active={activeSection === item.id}
                  onClick={() => setActiveSection(item.id)}
                />
              ))}
            </nav>
          </div>
        ))}
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
          {activeSection === "data" ? <AdvancedPanel /> : null}
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
