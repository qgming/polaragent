import { Copy, Minus, PanelLeft, Square, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/**
 * 内容区顶栏：侧栏展开按钮 + 会话标题 + 运行状态 + 窗口控制。
 *
 * 它只横跨内容区 —— 侧栏占满整窗高度、自带一条同高的顶行（品牌与搜索/收起在 SidebarShell），
 * 所以品牌标记不在这里。两行等高（44px）且共用同一条下边框，视觉上连成贯穿整窗的一线。
 * 会话标题原本是内容区里第二条同高横带（MainShell），现合并到这里，内容区只剩对话本身。
 *
 * 侧栏展开按钮只在侧栏关闭时出现（关闭 = 完全隐藏，见 SidebarShell），
 * 占据标题左侧；侧栏展开时这里不留占位，标题紧贴左边距。
 * 整条是窗口拖拽区（data-electron-drag-region 的规则见 index.css，button 已统一 no-drag）。
 */
export function TitleBar() {
  const { t } = useTranslation();
  // 最大化状态：true 时窗口控制图标切换为「还原」（Copy 双叠方块语义）
  const [maximized, setMaximized] = useState(false);

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 该会话是否有一次运行在进行：live 蓝只用来表示这件事
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

  const title = sessions.find((s) => s.id === activeSessionId)?.title ?? t("chat.newChat");

  useEffect(() => {
    // 订阅主进程的最大化状态变化，返回取消订阅函数
    return window.polaragent.window.onMaximizedChange(setMaximized);
  }, []);

  return (
    <header
      data-electron-drag-region
      // 隐藏态收紧左内边距与标题前的间隙：icon-sm 按钮四周各有 8px 内衬，
      // 于是 pl-1(4px) + gap-1(4px) 让展开图标落在 12px、标题落在 40px ——
      // 与侧栏顶行的品牌图标（8+4）和应用名（12+20+8）逐像素对齐，
      // 侧栏展开/隐藏来回切时左边缘不跳动。展开态没有这个按钮，保持原来的 pl-4 / gap-2。
      className={cn(
        "flex h-11 shrink-0 items-center border-b border-border/60 pr-2",
        collapsed ? "gap-1 pl-1" : "gap-2 pl-4",
      )}
    >
      {/* 左侧：侧栏展开（仅侧栏关闭时）+ 会话标题 + 运行状态 */}
      {collapsed && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("app.expandSidebar")}
          onClick={toggleSidebar}
        >
          <PanelLeft className="size-4" />
        </Button>
      )}
      <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
      {running && (
        <span className={cn(live, "flex shrink-0 items-center gap-1.5 text-[11px]")} role="status">
          <ShimmerLabel>{t("chat.running")}</ShimmerLabel>
        </span>
      )}

      {/* 右侧：窗口控制；主题切换在侧栏底部 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
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
