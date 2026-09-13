import { Copy, Minus, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";

/**
 * 窗口控制三件套：最小化 / 最大化（还原）/ 关闭。
 *
 * 抽成独立组件是因为它有**两个宿主**：内容区顶栏，以及右侧栏展开后的顶行。
 * 右侧栏展开时窗口控制要挪到侧边栏右上角（与顶栏同一行的右端），
 * 两处各写一遍就会漂移 —— 尺寸、悬停底、最大化图标的状态切换都得同步维护。
 *
 * 最大化状态在这里订阅（而不是由宿主传入）：它是窗口自身的属性，
 * 与宿主是谁无关。宿主数量变化时订阅也跟着走，不会漏。
 */
export function WindowControls(): React.JSX.Element {
  const { t } = useTranslation();
  // 最大化状态：true 时图标切换为「还原」（Copy 双叠方块语义）
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 订阅主进程的最大化状态变化，返回取消订阅函数
    return window.oint.window.onMaximizedChange(setMaximized);
  }, []);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("app.minimize")}
        title={t("app.minimize")}
        onClick={() => void window.oint.window.minimize()}
      >
        <Minus className="size-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("app.maximize")}
        title={t("app.maximize")}
        onClick={() => void window.oint.window.toggleMaximize()}
      >
        {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
      </Button>
      {/* 关闭：hover 用 destructive 底 + 前景，区别于其他窗口控制 */}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t("app.closeWindow")}
        title={t("app.closeWindow")}
        className="hover:bg-destructive hover:text-destructive-foreground"
        onClick={() => void window.oint.window.close()}
      >
        <X className="size-4" />
      </Button>
    </>
  );
}
