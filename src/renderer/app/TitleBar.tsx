import { Copy, Minus, Square, X } from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ThemeToggle } from "@/renderer/components/ThemeToggle";
import { Button } from "@/renderer/components/ui/button";

// Electron 自定义拖拽属性不属于标准 CSS，补充到类型里
type DragStyle = CSSProperties & { WebkitAppRegion?: "drag" | "no-drag" };

const dragStyle: DragStyle = { WebkitAppRegion: "drag" };
const noDragStyle: DragStyle = { WebkitAppRegion: "no-drag" };

export function TitleBar() {
  const { t } = useTranslation();
  // 最大化状态：true 时窗口控制图标切换为「还原」（Copy 双叠方块语义）
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    // 订阅主进程的最大化状态变化，返回取消订阅函数
    return window.polaragent.window.onMaximizedChange(setMaximized);
  }, []);

  return (
    <header
      style={dragStyle}
      className="flex h-11 shrink-0 items-center justify-between border-b border-border/60 px-2"
    >
      {/* 左侧：品牌标记 + 应用名（标记是墨色方块，不是强调色） */}
      <div className="flex min-w-0 items-center gap-2 px-2">
        <span className="size-2 shrink-0 rounded-sm bg-foreground" aria-hidden="true" />
        <span className="truncate text-sm font-medium">{t("app.name")}</span>
      </div>

      {/* 右侧：主题切换 + 窗口控制；按钮区不可拖拽 */}
      <div style={noDragStyle} className="flex items-center gap-1">
        <ThemeToggle />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("app.minimize")}
          onClick={() => void window.polaragent.window.minimize()}
        >
          <Minus className="size-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("app.maximize")}
          onClick={() => void window.polaragent.window.toggleMaximize()}
        >
          {maximized ? <Copy className="size-3.5" /> : <Square className="size-3.5" />}
        </Button>
        {/* 关闭：hover 用 destructive 底 + 前景，区别于其他窗口控制 */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("app.closeWindow")}
          className="hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => void window.polaragent.window.close()}
        >
          <X className="size-4" />
        </Button>
      </div>
    </header>
  );
}
