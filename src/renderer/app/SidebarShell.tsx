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

/** 侧栏里的图标按钮：图标 + 右侧 tooltip（侧栏靠窗口左缘，浮层向右弹出） */
function IconButton({
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

/** 品牌标记：内置图标资源（public/logo.png，与 index.html 的 favicon 是同一份文件）。
 *  图形本身是装饰性的，应用名文本就在旁边，所以 alt 留空。
 *  draggable=false：顶行整体是窗口拖拽区，浏览器原生的图片拖拽会与之抢事件。 */
function BrandMark() {
  return (
    <img
      src="./logo.png"
      alt=""
      aria-hidden="true"
      draggable={false}
      className="size-5 shrink-0 object-contain"
    />
  );
}

/**
 * 侧栏：会话列表整体交给 assistant-ui 官方的 thread-list 部件
 *（ThreadListRoot / New / Items + ThreadListItem），
 * 会话数据由 PolarRuntimeProvider 的 threadList 适配器从 chat-store 供上。
 * 顶部的搜索入口、底部的设置/主题是该部件的扩展位，不在官方组件内，
 * 按 Elements 的图标按钮口径自建。搜索不在这里做（不做列表内筛选），统一走搜索模态窗。
 *
 * 两态只有「展开 / 完全隐藏」：关闭时宽度收到 0、内容整体滑出被剪裁，
 * 不再是原来那条 48px 图标轨道（展开入口移到了内容区顶栏的标题左侧，见 TitleBar）。
 */
export function SidebarShell() {
  const { t } = useTranslation();

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSearch = useUiStore((s) => s.openSearch);
  const openSettings = useUiStore((s) => s.openSettings);
  const pendingDeleteSessionId = useUiStore((s) => s.pendingDeleteSessionId);
  const settleDeleteSession = useUiStore((s) => s.settleDeleteSession);

  const deleteTitle = useChatStore(
    (s) => s.sessions.find((item) => item.id === pendingDeleteSessionId)?.title ?? null,
  );

  return (
    <aside
      // inert：宽度 0 + 剪裁只是视觉上不可见，里面的按钮仍可被 Tab 命中、仍进辅助技术树，
      // 所以隐藏期间显式整棵子树置为不可交互。
      inert={collapsed}
      className="shrink-0 overflow-hidden bg-sidebar transition-[width] duration-200 motion-reduce:transition-none"
      style={{ width: collapsed ? "0px" : "var(--layout-sidebar-width)" }}
    >
      {/* 内层锁死展开宽度：折叠动画期间内容不跟着挤压重排，只是被右边缘剪掉（含那条右边框） */}
      <div
        className="flex h-full flex-col border-r border-border/60"
        style={{ width: "var(--layout-sidebar-width)" }}
      >
        {/* 顶行：侧栏从这里起就是窗口最顶部（整宽顶栏已去掉），与内容区顶栏等高、
            共用同一条下边框。左侧是品牌图标与应用名，右侧是搜索与收起开关（先搜索、后收起）；
            整行是窗口拖拽区。 */}
        <div
          data-electron-drag-region
          className="flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2"
        >
          <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
            <BrandMark />
            <span className="truncate text-sm font-medium">{t("app.name")}</span>
          </div>
          <IconButton label={t("common.search")} onClick={openSearch}>
            <Search className="size-4" />
          </IconButton>
          <IconButton label={t("app.collapseSidebar")} onClick={toggleSidebar}>
            <PanelLeft className="size-4" />
          </IconButton>
        </div>

        <ThreadListRoot className="min-h-0 flex-1 overflow-hidden px-2 pt-2 pb-2">
          <ThreadListNew>
            <Plus className="size-4 shrink-0" />
            <span className="whitespace-nowrap">{t("sidebar.newChat")}</span>
          </ThreadListNew>
          <ThreadListItems className="app-scrollbar min-h-0 flex-1 overflow-y-auto" />
        </ThreadListRoot>

        {/* 底部：设置（左）+ 主题切换（右） */}
        <div className="border-t border-border/60 p-2">
          <div className="flex items-center justify-between">
            <IconButton label={t("sidebar.settings")} onClick={() => openSettings()}>
              <Settings2 className="size-4" />
            </IconButton>
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
      </div>
    </aside>
  );
}
