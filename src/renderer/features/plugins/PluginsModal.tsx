import { useTranslation } from "react-i18next";
import { typeSection } from "@/renderer/components/assistant-ui/type";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { cn } from "@/renderer/lib/utils";
import { useUiStore } from "@/renderer/stores/ui-store";
import { PluginsPanel } from "./panels/PluginsPanel";

/**
 * 插件管理模态窗。
 *
 * ## 为什么没有左侧导航了
 *
 * 早先它是**照着设置模态窗抄的**：880×640、200px 左导航、四个分栏。那个骨架在
 * "有四个并列的能力面"时是对的。
 *
 * 但分栏收敛成「系统 / 用户」之后，左导航只剩**一项** —— 一个只有一项的导航不是导航，
 * 是一条占着 200px 宽度、什么也不做的竖条。所以整块去掉，来源切换挪进内容区的工具条。
 *
 * **留下的是它真正有价值的那部分**：与设置模态同尺寸（两个模态来回切不会跳）、
 * 同圆角、同动效、同标题字号（`typeSection`）。**共用视觉语言 ≠ 共用骨架。**
 *
 * ## 宽度还给内容
 *
 * 去掉 200px 之后，插件行多了整整 200px 放权限 chip 与操作按钮 —— 那是这一屏
 * 信息密度最高的东西，而它们原先挤在 680px 里换行。
 */
export function PluginsModal() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.pluginsOpen);
  const closePlugins = useUiStore((s) => s.closePlugins);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closePlugins()}>
      {/* 与设置模态同尺寸：880×640、xl 圆角。`flex-col` + 内容区自己滚动 */}
      <DialogContent className="flex h-[640px] max-h-[86vh] w-[880px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        {/*
          头部：标题 + 一句话说明。
          **说明不是装饰** —— 这一屏最需要事先讲清的是"用户装的插件默认是停用的"，
          否则用户装完会以为没生效（而它默认停用正是为了让用户先看一眼权限）。
        */}
        <header className="shrink-0 border-border/60 border-b px-5 pt-4 pb-3">
          <DialogTitle className={cn(typeSection, "text-foreground")}>
            {t("plugins.title")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs text-ink-4">
            {t("plugins.subtitle")}
          </DialogDescription>
        </header>

        {/* 内容区：工具条固定、列表自己滚动（工具条跟着滚走的话，切来源要先滚回顶部） */}
        <PluginsPanel />
      </DialogContent>
    </Dialog>
  );
}
