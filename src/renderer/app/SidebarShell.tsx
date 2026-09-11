import { PanelLeft, Plus, Search, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  ThreadListItems,
  ThreadListNew,
  ThreadListRoot,
} from "@/renderer/components/assistant-ui/elements/thread-list.aui";
import { ThemeToggle } from "@/renderer/components/ThemeToggle";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

/** 折叠态图标轨道里的单个按钮：图标 + 右侧 tooltip */
function RailButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * 侧栏：会话列表整体交给 assistant-ui 官方的 thread-list 部件
 *（ThreadListRoot / New / Items + ThreadListItem），
 * 会话数据由 PolarRuntimeProvider 的 threadList 适配器从 chat-store 供上。
 * 折叠轨道与顶部的搜索入口、底部的设置/主题是该部件的扩展位，不在官方组件内，
 * 按 Elements 的图标按钮口径自建。搜索不在这里做（不做列表内筛选），统一走搜索模态窗。
 */
export function SidebarShell() {
  const { t } = useTranslation();

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSearch = useUiStore((s) => s.openSearch);
  const openSettings = useUiStore((s) => s.openSettings);
  const pendingDeleteSessionId = useUiStore((s) => s.pendingDeleteSessionId);
  const settleDeleteSession = useUiStore((s) => s.settleDeleteSession);
  const createSession = useChatStore((s) => s.createSession);

  const collapseLabel = collapsed ? t("app.expandSidebar") : t("app.collapseSidebar");

  const deleteTitle = useChatStore(
    (s) => s.sessions.find((item) => item.id === pendingDeleteSessionId)?.title ?? null,
  );

  return (
    <aside
      className="flex shrink-0 flex-col border-r border-border/60 bg-sidebar transition-[width] duration-200 motion-reduce:transition-none"
      style={{
        width: collapsed ? "var(--layout-sidebar-width-collapsed)" : "var(--layout-sidebar-width)",
      }}
    >
      {collapsed ? (
        /* 折叠态：图标轨道，hover 出 tooltip */
        <div className="flex flex-col items-center gap-1 p-2">
          <RailButton label={collapseLabel} onClick={toggleSidebar}>
            <PanelLeft className="size-4" />
          </RailButton>
          <RailButton label={t("common.search")} onClick={openSearch}>
            <Search className="size-4" />
          </RailButton>
          <RailButton label={t("sidebar.newChat")} onClick={() => void createSession()}>
            <Plus className="size-4" />
          </RailButton>
        </div>
      ) : (
        <>
          {/* 折叠开关与搜索都是官方列表之外的控件，单独一行，避免挤压 New 的整宽按钮 */}
          <div className="flex items-center gap-1 p-2 pb-0">
            <RailButton label={collapseLabel} onClick={toggleSidebar}>
              <PanelLeft className="size-4" />
            </RailButton>
            <RailButton label={t("common.search")} onClick={openSearch}>
              <Search className="size-4" />
            </RailButton>
          </div>

          <ThreadListRoot className="min-h-0 flex-1 overflow-hidden px-2 pb-2">
            <ThreadListNew>
              <Plus className="size-4 shrink-0" />
              <span className="whitespace-nowrap">{t("sidebar.newChat")}</span>
            </ThreadListNew>
            <ThreadListItems className="app-scrollbar min-h-0 flex-1 overflow-y-auto" />
          </ThreadListRoot>
        </>
      )}

      {/* 底部：设置（左）+ 主题切换（右） */}
      <div
        className={`border-t border-border/60 p-2 ${collapsed ? "flex flex-col items-center gap-1" : ""}`}
      >
        <div className={collapsed ? "" : "flex items-center justify-between"}>
          <RailButton label={t("sidebar.settings")} onClick={() => openSettings()}>
            <Settings2 className="size-4" />
          </RailButton>
          <ThemeToggle side="right" />
        </div>
      </div>

      {/* 删除确认：官方 thread-list 的 Delete 立即执行，这里兜住不可撤销的删除 */}
      <Dialog
        open={pendingDeleteSessionId !== null}
        onOpenChange={(open) => {
          if (!open) settleDeleteSession(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>「{deleteTitle ?? ""}」</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => settleDeleteSession(false)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={() => settleDeleteSession(true)}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
