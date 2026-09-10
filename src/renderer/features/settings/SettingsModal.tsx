import { FileText, Info, Server, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { ScrollArea } from "@/renderer/components/ui/scroll-area";
import { cn } from "@/renderer/lib/utils";
import { type SettingsSection, useUiStore } from "@/renderer/stores/ui-store";
import { AboutPanel } from "./panels/AboutPanel";
import { GeneralPanel } from "./panels/GeneralPanel";
import { PermissionsPanel } from "./panels/PermissionsPanel";
import { PersonalizationPanel } from "./panels/PersonalizationPanel";
import { ServicesPanel } from "./panels/ServicesPanel";
import { SkillsPanel } from "./panels/SkillsPanel";

// 左侧分类导航：图标语义与设计稿 B9 一致
const SECTIONS: readonly {
  id: SettingsSection;
  labelKey: string;
  Icon: typeof Settings2;
}[] = [
  { id: "general", labelKey: "settings.general", Icon: Settings2 },
  { id: "services", labelKey: "settings.services", Icon: Server },
  { id: "permissions", labelKey: "settings.permissions", Icon: ShieldCheck },
  { id: "skills", labelKey: "settings.skills", Icon: Sparkles },
  { id: "personalization", labelKey: "settings.personalization", Icon: FileText },
  { id: "about", labelKey: "settings.about", Icon: Info },
];

/** 按当前分类渲染面板；本地条件渲染，不引入 Tabs（浮层内不需要额外键盘层） */
function renderPanel(section: SettingsSection) {
  switch (section) {
    case "general":
      return <GeneralPanel />;
    case "services":
      return <ServicesPanel />;
    case "permissions":
      return <PermissionsPanel />;
    case "skills":
      return <SkillsPanel />;
    case "personalization":
      return <PersonalizationPanel />;
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
        {/* 左侧 200px 分类导航；标题同时作为 Dialog 可访问名称 */}
        <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-border border-r bg-sidebar p-2">
          <DialogTitle className="px-3 py-2 text-sm font-medium">{t("settings.title")}</DialogTitle>
          <DialogDescription className="sr-only">{t("settings.title")}</DialogDescription>
          {SECTIONS.map((section) => {
            const active = section.id === settingsSection;
            return (
              <button
                key={section.id}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => openSettings(section.id)}
                className={cn(
                  "relative flex h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none",
                  active
                    ? "bg-brand-muted text-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-foreground",
                )}
              >
                {/* 当前分类左侧 2px 品牌竖条（E2 落点③） */}
                {active ? (
                  <span
                    className="absolute top-1 bottom-1 left-0 w-0.5 bg-brand"
                    aria-hidden="true"
                  />
                ) : null}
                <section.Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{t(section.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        {/* 右侧面板：独立滚动，内容区留 20px 内边距 */}
        <section className="min-w-0 flex-1">
          <ScrollArea className="h-full">
            <div className="p-5">{renderPanel(settingsSection)}</div>
          </ScrollArea>
        </section>
      </DialogContent>
    </Dialog>
  );
}
