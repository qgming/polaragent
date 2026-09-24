import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { typeSection } from "@/renderer/components/assistant-ui/type";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { cn } from "@/renderer/lib/utils";
import { useStatsStore } from "@/renderer/stores/stats-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { StatsPanel } from "./panels/StatsPanel";

/**
 * 数据统计模态窗。
 *
 * 骨架与插件管理模态窗**逐像素对齐**（880×640、xl 圆角、同标题字号）：用户在这两个
 * 入口之间来回切时，窗口不该跳一下 —— 它们都是「这台机器现在是什么样」的一屏。
 *
 * 打开时拉一次报告，关闭时停掉轮询（历史折叠是分拍的，见 stats-store）。
 * **不清数据**：再打开时先用上一次的报告把界面填上，刷新在后台静默进行 ——
 * 一份「越来越准」的数据没必要每次都从骨架屏开始。
 */
export function StatsModal() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.statsOpen);
  const closeStats = useUiStore((s) => s.closeStats);
  const load = useStatsStore((s) => s.load);
  const stop = useStatsStore((s) => s.stop);

  useEffect(() => {
    if (!open) return undefined;
    void load();
    return () => stop();
  }, [open, load, stop]);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeStats()}>
      <DialogContent className="flex h-[640px] max-h-[86vh] w-[880px] max-w-[92vw] flex-col gap-0 overflow-hidden rounded-xl p-0 sm:max-w-[92vw]">
        <header className="shrink-0 border-border/60 border-b px-5 pt-4 pb-3">
          <DialogTitle className={cn(typeSection, "text-foreground")}>
            {t("stats.title")}
          </DialogTitle>
          <DialogDescription className="mt-1 text-xs text-ink-4">
            {t("stats.subtitle")}
          </DialogDescription>
        </header>

        <StatsPanel />
      </DialogContent>
    </Dialog>
  );
}
