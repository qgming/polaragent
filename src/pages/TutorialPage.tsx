// 使用教程页面 - 左侧导航 + 右侧教程内容
// src/pages/TutorialPage.tsx

import { useState } from "react";
import { ArrowLeft, BookOpen, MessageSquare, Bot, Wrench, Package, Users, Database, Settings2, Lightbulb, HelpCircle, Globe, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { QuickStartGuide } from "@/components/tutorial/QuickStartGuide";
import { ChatGuide } from "@/components/tutorial/ChatGuide";
import { AgentGuide } from "@/components/tutorial/AgentGuide";
import { SkillGuide } from "@/components/tutorial/SkillGuide";
import { ToolGuide } from "@/components/tutorial/ToolGuide";
import { TeamGuide } from "@/components/tutorial/TeamGuide";
import { KnowledgeGuide } from "@/components/tutorial/KnowledgeGuide";
import { ModelGuide } from "@/components/tutorial/ModelGuide";
import { BrowserUseGuide } from "@/components/tutorial/BrowserUseGuide";
import { ComputerUseGuide } from "@/components/tutorial/ComputerUseGuide";
import { TipsGuide } from "@/components/tutorial/TipsGuide";
import { FaqGuide } from "@/components/tutorial/FaqGuide";

export type TutorialSection =
  | "quickstart"
  | "chat"
  | "agent"
  | "skill"
  | "tool"
  | "team"
  | "knowledge"
  | "model"
  | "browseruse"
  | "computeruse"
  | "tips"
  | "faq";

// 左侧导航分组
const navGroups: Array<{
  titleKey: string;
  items: Array<{ id: TutorialSection; labelKey: string; icon: typeof BookOpen }>;
}> = [
  {
    titleKey: "nav.groups.quickstart",
    items: [
      { id: "quickstart", labelKey: "nav.items.quickstart", icon: BookOpen },
    ],
  },
  {
    titleKey: "nav.groups.basic",
    items: [
      { id: "chat", labelKey: "nav.items.chat", icon: MessageSquare },
      { id: "agent", labelKey: "nav.items.agent", icon: Bot },
      { id: "skill", labelKey: "nav.items.skill", icon: Package },
      { id: "tool", labelKey: "nav.items.tool", icon: Wrench },
    ],
  },
  {
    titleKey: "nav.groups.advanced",
    items: [
      { id: "team", labelKey: "nav.items.team", icon: Users },
      { id: "knowledge", labelKey: "nav.items.knowledge", icon: Database },
      { id: "model", labelKey: "nav.items.model", icon: Settings2 },
      { id: "browseruse", labelKey: "nav.items.browseruse", icon: Globe },
      { id: "computeruse", labelKey: "nav.items.computeruse", icon: Monitor },
    ],
  },
  {
    titleKey: "nav.groups.help",
    items: [
      { id: "tips", labelKey: "nav.items.tips", icon: Lightbulb },
      { id: "faq", labelKey: "nav.items.faq", icon: HelpCircle },
    ],
  },
];

export function TutorialPage({
  initialSection = "quickstart",
  onBack,
}: {
  initialSection?: TutorialSection;
  onBack: () => void;
}) {
  const { t } = useTranslation("tutorial");
  const [activeSection, setActiveSection] = useState<TutorialSection>(initialSection);

  return (
    <div className="flex h-full min-w-0 bg-background">
      <aside className="app-scrollbar w-[220px] shrink-0 overflow-y-auto border-r border-border bg-background px-3 py-5">
        <button
          type="button"
          onClick={onBack}
          className="mb-8 flex items-center gap-2 px-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("backToApp")}
        </button>

        {navGroups.map((group, index) => (
          <div key={group.titleKey} className={index > 0 ? "mt-6" : undefined}>
            <p className="mb-2 px-3 text-xs font-medium text-muted-foreground">
              {t(group.titleKey)}
            </p>
            <nav className="space-y-1">
              {group.items.map((item) => (
                <NavButton
                  key={item.id}
                  item={item}
                  active={activeSection === item.id}
                  onClick={() => setActiveSection(item.id)}
                  label={t(item.labelKey)}
                />
              ))}
            </nav>
          </div>
        ))}
      </aside>

      <main className="app-scrollbar min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[980px] px-8 py-14">
          {activeSection === "quickstart" && <QuickStartGuide />}
          {activeSection === "chat" && <ChatGuide />}
          {activeSection === "agent" && <AgentGuide />}
          {activeSection === "skill" && <SkillGuide />}
          {activeSection === "tool" && <ToolGuide />}
          {activeSection === "team" && <TeamGuide />}
          {activeSection === "knowledge" && <KnowledgeGuide />}
          {activeSection === "model" && <ModelGuide />}
          {activeSection === "browseruse" && <BrowserUseGuide />}
          {activeSection === "computeruse" && <ComputerUseGuide />}
          {activeSection === "tips" && <TipsGuide />}
          {activeSection === "faq" && <FaqGuide />}
        </div>
      </main>
    </div>
  );
}

// 左侧导航按钮
function NavButton({
  item,
  label,
  active,
  onClick,
}: {
  item: { id: TutorialSection; labelKey: string; icon: typeof BookOpen };
  label: string;
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
      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
    </button>
  );
}
