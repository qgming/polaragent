import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useUiStore } from "@/renderer/stores/ui-store";

/**
 * 右侧面板的入口按钮：只负责开合，不再弹菜单。
 *
 * 为什么把选择移到面板内部：弹出菜单再选一次，等于让「打开侧边栏」和「选内容」
 * 分成两个动作、两处界面。现在按钮直接把面板展开，面板自己的第一屏就是那五个入口
 *（审查 / 文件 / 侧边聊天 / 浏览器 / 终端），点一下即进入 —— 选择发生在侧边栏里，
 * 与参考图一致。
 *
 * 按钮形态对齐相邻的 SessionPanel 图标按钮：两者同处内容区顶栏、都在窗口控制左边，
 * 尺寸/悬停底/无障碍名称不一致会立刻看出来。
 */
export function RightPanelToggle(): React.JSX.Element {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.rightPanelOpen);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  const label = open ? t("rightPanel.close") : t("rightPanel.open");

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      aria-expanded={open}
      title={label}
      onClick={toggleRightPanel}
      className={cn(open && "bg-accent text-accent-foreground dark:bg-accent/50")}
    >
      <PanelRight className="size-4" />
    </Button>
  );
}
