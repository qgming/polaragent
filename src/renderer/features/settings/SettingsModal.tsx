import { Database, FileText, Info, Server, Settings2, Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { typeSection } from "@/renderer/components/assistant-ui/type";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { ScrollArea } from "@/renderer/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/renderer/components/ui/tabs";
import { cn } from "@/renderer/lib/utils";
import { type SettingsSection, useUiStore } from "@/renderer/stores/ui-store";
import { AboutPanel } from "./panels/AboutPanel";
import { DataPanel } from "./panels/DataPanel";
import { GeneralPanel } from "./panels/GeneralPanel";
import { PersonalizationPanel } from "./panels/PersonalizationPanel";
import { ServicesPanel } from "./panels/ServicesPanel";
import { SkillsPanel } from "./panels/SkillsPanel";
import { SettingsPanelTitle } from "./settings-shared";

// 左侧分类导航：图标语义取自 Elements 的 settings 面
const SECTIONS: readonly {
  id: SettingsSection;
  labelKey: string;
  Icon: typeof Settings2;
}[] = [
  { id: "general", labelKey: "settings.general", Icon: Settings2 },
  { id: "services", labelKey: "settings.services", Icon: Server },
  { id: "skills", labelKey: "settings.skills", Icon: Sparkles },
  { id: "personalization", labelKey: "settings.personalization", Icon: FileText },
  { id: "data", labelKey: "settings.data", Icon: Database },
  { id: "about", labelKey: "settings.about", Icon: Info },
];

/** 分类项：官方 Tabs 的垂直变体，只把选中态改成中性墨色淡底（Elements 的 field 量级），不画竖条 */
const navItem = cn(
  "h-8 w-full flex-none justify-start gap-2 rounded-[10px] px-3 text-sm font-normal",
  "text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground",
  "data-[state=active]:bg-foreground/[0.06] data-[state=active]:text-foreground",
  "dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-foreground/[0.09]",
  "focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none",
);

/** 按当前分类渲染面板：每个分类一个 tabpanel，官方 Tabs 默认只挂载当前项 */
function renderPanel(section: SettingsSection) {
  switch (section) {
    case "general":
      return <GeneralPanel />;
    case "services":
      return <ServicesPanel />;
    case "skills":
      return <SkillsPanel />;
    case "personalization":
      return <PersonalizationPanel />;
    case "data":
      return <DataPanel />;
    case "about":
      return <AboutPanel />;
  }
}

export function SettingsModal() {
  const { t } = useTranslation();
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const settingsSection = useUiStore((s) => s.settingsSection);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);

  return (
    <Dialog open={settingsOpen} onOpenChange={(open) => !open && closeSettings()}>
      {/* 大模态：880×640，12px 圆角（xl 档）；内部自行控制内边距 */}
      <DialogContent className="flex h-[640px] max-h-[86vh] w-[880px] max-w-[92vw] gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        <Tabs
          orientation="vertical"
          value={settingsSection}
          // 值只来自 SECTIONS，断言安全
          onValueChange={(value) => openSettings(value as SettingsSection)}
          className="flex min-h-0 w-full gap-0"
        >
          {/* 左侧 200px 分类导航。标题不能放进 TabsList 内 —— tablist 只允许包含 tab */}
          <div className="flex w-[200px] shrink-0 flex-col border-border/60 border-r bg-sidebar p-2">
            {/* 标题同时作为 Dialog 的可访问名称 */}
            <DialogTitle className={cn(typeSection, "px-2.5 pt-1 pb-2")}>
              {t("settings.title")}
            </DialogTitle>
            <DialogDescription className="sr-only">{t("settings.title")}</DialogDescription>
            <TabsList
              aria-label={t("settings.title")}
              className="w-full flex-col items-stretch justify-start gap-0.5 rounded-none bg-transparent p-0"
            >
              {SECTIONS.map((section) => (
                <TabsTrigger key={section.id} value={section.id} className={navItem}>
                  <section.Icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="truncate">{t(section.labelKey)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* 右侧面板：独立滚动，内容区留 20px 内边距 */}
          <div className="min-w-0 flex-1">
            <ScrollArea className="h-full">
              {SECTIONS.map((section) => (
                <TabsContent key={section.id} value={section.id} className="p-5">
                  {/*
                    分类切换是「内容换了一屏」，做一次轻微的淡入 + 上移来说明这件事。
                    官方 Tabs 只挂载当前项，所以只需要进场；reducedMotion="user" 下
                    位移被抑制、只留透明度变化（见 App.tsx 的 MotionConfig）。
                  */}
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
                  >
                    {/* 大标题：分类名。五个分类在这里统一渲染，面板自身不写标题 */}
                    <SettingsPanelTitle>{t(section.labelKey)}</SettingsPanelTitle>
                    {renderPanel(section.id)}
                  </motion.div>
                </TabsContent>
              ))}
            </ScrollArea>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
