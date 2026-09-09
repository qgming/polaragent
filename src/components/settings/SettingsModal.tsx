// 设置大模态窗：左导航（含搜索）+ 右面板
// src/components/settings/SettingsModal.tsx

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Brain,
  FileText,
  Globe,
  Info,
  Monitor,
  Search,
  Settings2,
  Sparkles,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { initializeAiRuntime } from "@/lib/app-init";
import { useConfigStore } from "@/stores/config-store";
import { useSettingsUiStore, type SettingsSection } from "@/stores/settings-ui-store";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { GeneralPanel } from "./panels/GeneralPanel";
import { ModelsPanel } from "./panels/ModelsPanel";
import { WebSearchPanel } from "./WebSearchPanel";
import { MemoryPanel } from "./MemoryPanel";
import { AgentsMdPanel } from "./AgentsMdPanel";
import { AutomationPanel } from "./panels/AutomationPanel";
import { AboutPanel } from "./AboutPanel";

type NavItem = { id: SettingsSection; icon: LucideIcon; labelKey: string; keywords: string };

const navGroups: Array<{ titleKey: string; items: NavItem[] }> = [
  {
    titleKey: "settings:nav.groupGeneral",
    items: [
      { id: "general", icon: Settings2, labelKey: "settings:nav.general", keywords: "general 通用 语言 主题 窗口 数据 language theme window" },
      { id: "models", icon: Sparkles, labelKey: "settings:nav.models", keywords: "model 模型 图片 音频 嵌入 image audio embedding provider" },
    ],
  },
  {
    titleKey: "settings:nav.groupCapability",
    items: [
      { id: "webSearch", icon: Globe, labelKey: "settings:nav.webSearch", keywords: "search 搜索 网络 tavily exa brave" },
      { id: "memory", icon: Brain, labelKey: "settings:nav.memory", keywords: "memory 记忆 全局" },
      { id: "personal", icon: FileText, labelKey: "settings:nav.personal", keywords: "personal 个性化 agents.md 指令 prompt 系统提示" },
    ],
  },
  {
    titleKey: "settings:nav.groupAutomation",
    items: [
      { id: "automation", icon: Monitor, labelKey: "settings:nav.automation", keywords: "automation 自动化 computer browser 浏览器 桌面" },
    ],
  },
  {
    titleKey: "settings:nav.groupAbout",
    items: [
      { id: "about", icon: Info, labelKey: "settings:nav.about", keywords: "about 关于 更新 version update" },
    ],
  },
];

export function SettingsModal() {
  const { t } = useTranslation();
  const open = useSettingsUiStore((s) => s.settingsOpen);
  const setOpen = useSettingsUiStore((s) => s.setSettingsOpen);
  const activeSection = useSettingsUiStore((s) => s.activeSection);
  const setActiveSection = useSettingsUiStore((s) => s.setActiveSection);
  const [query, setQuery] = useState("");

  const providers = useConfigStore((state) => state.providers);
  const settings = useConfigStore((state) => state.settings);
  const updateSettings = useConfigStore((state) => state.updateSettings);
  const updateProvider = useConfigStore((state) => state.updateProvider);
  const addProvider = useConfigStore((state) => state.addProvider);
  const removeProvider = useConfigStore((state) => state.removeProvider);
  const setDefaultModel = useConfigStore((state) => state.setDefaultModel);

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return navGroups;
    return navGroups
      .map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            item.keywords.toLowerCase().includes(q) ||
            t(item.labelKey).toLowerCase().includes(q),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [query, t]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="h-[min(700px,calc(100vh-2.5rem))] w-[min(880px,calc(100vw-2.5rem))] max-w-none overflow-hidden rounded-2xl border-border/60 bg-background p-0 shadow-2xl sm:max-w-none"
        aria-describedby={undefined}
      >
        <DialogTitle className="sr-only">{t("settings:nav.title", "设置")}</DialogTitle>

        <div className="grid min-h-0 grid-cols-[210px_minmax(0,1fr)]">
          {/* 左侧导航 */}
          <aside className="flex min-h-0 flex-col border-r border-border/40 bg-[#f8f7f5] dark:bg-muted/20">
            <div className="px-5 pt-6 pb-4">
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                {t("settings:nav.title", "设置")}
              </h2>
              <div className="relative mt-4">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("settings:nav.searchPlaceholder", "搜索设置")}
                  className="h-9 w-full rounded-xl border border-border/50 bg-background pl-9 pr-3 text-[13px] outline-none transition-colors placeholder:text-muted-foreground/60 focus-visible:border-ring/50 focus-visible:ring-[3px] focus-visible:ring-ring/15"
                />
              </div>
            </div>

            <nav className="min-h-0 flex-1 overflow-y-auto px-3 pb-5">
              {filteredGroups.map((group, gi) => (
                <div key={group.titleKey} className={gi > 0 ? "mt-5" : undefined}>
                  <p className="mb-1.5 px-3 text-[11px] font-medium tracking-wide text-muted-foreground/60">
                    {t(group.titleKey)}
                  </p>
                  <div className="space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => setActiveSection(item.id)}
                          className={cn(
                            "flex h-9 w-full items-center gap-3 rounded-lg px-3 text-[13px] font-medium transition-colors outline-none",
                            activeSection === item.id
                              ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                              : "text-foreground/80 hover:bg-black/[0.03] hover:text-foreground dark:text-foreground/70 dark:hover:bg-white/[0.04]",
                          )}
                        >
                          <Icon className="size-4 shrink-0" />
                          <span className="truncate">{t(item.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {filteredGroups.length === 0 ? (
                <p className="px-3 py-6 text-xs text-muted-foreground/60">
                  {t("settings:nav.noResults", "无匹配项")}
                </p>
              ) : null}
            </nav>
          </aside>

          {/* 右侧面板 */}
          <main className="min-h-0 min-w-0 overflow-y-auto bg-white px-9 py-8 dark:bg-background">
            <div className="mx-auto w-full max-w-xl">
              {activeSection === "general" ? (
                <GeneralPanel settings={settings} onUpdate={updateSettings} />
              ) : null}
              {activeSection === "models" ? (
                <ModelsPanel
                  providers={providers}
                  settings={settings}
                  onUpdate={updateSettings}
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
              {activeSection === "memory" ? (
                <MemoryPanel settings={settings} onUpdate={updateSettings} />
              ) : null}
              {activeSection === "personal" ? <AgentsMdPanel /> : null}
              {activeSection === "automation" ? (
                <AutomationPanel settings={settings} onUpdate={updateSettings} />
              ) : null}
              {activeSection === "about" ? <AboutPanel /> : null}
            </div>
          </main>
        </div>
      </DialogContent>
    </Dialog>
  );
}
