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
// 注册表是这一屏**唯一**的来源：顺序、图标、文案键、内容都在描述子里。
// 这里不再有 SECTIONS 数组 + renderPanel switch 两份要同步的东西（过去漏改一处
// 的症状是「分栏在导航里但点不开」或「能打开但导航上没名字」）。
import { settingsSections } from "./sections";
import { modalNavItem, SettingsPanelTitle } from "./settings-shared";

/** 分类项样式来自 settings-shared 的 modalNavItem —— 与插件管理模态窗共用一份 */
const navItem = modalNavItem;

export function SettingsModal() {
  const { t } = useTranslation();
  const settingsOpen = useUiStore((s) => s.settingsOpen);
  const settingsSection = useUiStore((s) => s.settingsSection);
  const openSettings = useUiStore((s) => s.openSettings);
  const closeSettings = useUiStore((s) => s.closeSettings);
  /*
    每次渲染现取而不是放模块级常量：插件可以在运行期注册自己的设置页，
    模块级快照会让它永远不出现（面板注册表那边同理，见 useGlobalShortcuts 的说明）。
    十项的数组开销可以忽略。
  */
  const sections = settingsSections();

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
              {sections.map((section) => (
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
              {sections.map((section) => (
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
                    {/* 大标题：分类名。各分栏在这里统一渲染，面板自身不写标题 */}
                    <SettingsPanelTitle>{t(section.labelKey)}</SettingsPanelTitle>
                    <section.content />
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
