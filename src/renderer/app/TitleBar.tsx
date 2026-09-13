import { PanelLeft } from "lucide-react";
import { useTranslation } from "react-i18next";
import { WindowControls } from "@/renderer/app/WindowControls";
import { live, ShimmerLabel } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import { RightPanelToggle } from "@/renderer/features/right-panel/RightPanelToggle";
import { SessionPanel } from "@/renderer/features/session/SessionPanel";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/**
 * 内容区顶栏：侧栏展开按钮 + 会话标题 + 运行状态 + 会话面板 + 右侧栏开关（+ 窗口控制）。
 *
 * 它只横跨内容区 —— 侧栏占满整窗高度、自带一条同高的顶行（品牌与搜索/收起在 SidebarShell），
 * 所以品牌标记不在这里。三行等高（44px）且共用同一条下边框，视觉上连成贯穿整窗的一线。
 *
 * 侧栏展开按钮只在侧栏关闭时出现（关闭 = 完全隐藏，见 SidebarShell），
 * 占据标题左侧；侧栏展开时这里不留占位，标题紧贴左边距。
 * 整条是窗口拖拽区（data-electron-drag-region 的规则见 index.css，button 已统一 no-drag）。
 *
 * 窗口控制**只在右侧栏收起时留在这里**：右侧栏展开时它们移到侧边栏的右上角
 *（见 RightSidebar）—— 同一时刻屏幕上只有一套，不会出现两组一模一样的按钮。
 */
export function TitleBar() {
  const { t } = useTranslation();

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const sessions = useChatStore((s) => s.sessions);
  // 该会话是否有一次运行在进行：live 蓝只用来表示这件事
  const running = useChatStore(
    (s) => s.activeSessionId !== null && s.runningBySession[s.activeSessionId] === true,
  );

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  /** 右侧栏展开时，窗口控制由侧边栏接管（这里让位） */
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);

  const title = sessions.find((s) => s.id === activeSessionId)?.title ?? t("chat.newChat");

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

      {/* 右侧：会话面板 + 右侧栏开关（+ 窗口控制）；主题切换在侧栏底部 */}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <SessionPanel />
        {/* 右侧栏开关：直接展开面板，由面板自己列出五个入口（没有第二层浮层） */}
        <RightPanelToggle />
        {/* 窗口控制只在右侧栏收起时留在这里；展开时它们移进侧边栏右上角，
            同一时刻屏幕上只有一套 —— 否则会出现两组一模一样的按钮 */}
        {!rightPanelOpen && <WindowControls />}
      </div>
    </header>
  );
}
