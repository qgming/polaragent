// 左侧栏：品牌头、主导航、会话列表、底部设置
// src/components/sidebar/AppSidebar.tsx

import { ChevronDown, Loader2, PanelLeftClose, Plus, Search, Settings } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import {
  primaryNav,
  type PageId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { useSettingsUiStore } from "@/stores/settings-ui-store";
import { ThreadList } from "@/components/assistant-ui/elements/thread-list.aui";
import { ThreadListPrimitive } from "@assistant-ui/react";
import { SidebarButton } from "./SidebarButton";
import logo from "@/assets/logo.png";

export function AppSidebar({
  activePage,
  activeThreadId,
  onOpenPage,
  onToggleSidebar,
  onOpenSearch,
  runningThreadIds,
}: {
  activePage: PageId;
  activeThreadId: string;
  onOpenPage: (page: PageId) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSelectThread: (threadId: string) => void;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  runningThreadIds: string[];
}) {
  const chatHydrating = useChatStore((state) => state.hydrating);
  const chatHydrated = useChatStore((state) => state.hydrated);
  const [recentExpanded, setRecentExpanded] = useState(true);
  void runningThreadIds;

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 240, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border/40 bg-[#f8f7f5] text-sidebar-foreground dark:bg-muted/20"
    >
      <div className="flex h-full w-[240px] flex-col">
        {/* 顶部品牌行 */}
        <div className="flex h-11 shrink-0 items-center justify-between px-3">
          <div className="flex items-center gap-2">
            <img src={logo} alt="PolarAgent" className="size-5 object-contain" />
            <span className="text-sm font-semibold tracking-tight text-foreground">PolarAgent</span>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={onOpenSearch}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              title="搜索会话"
            >
              <Search className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleSidebar}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              title="收起侧边栏"
            >
              <PanelLeftClose className="size-3.5" />
            </button>
          </div>
        </div>

        {/* 主导航 */}
        <div className="flex flex-col px-3 pb-1">
          <nav className="space-y-1">
            {primaryNav.map((item) => (
              <SidebarButton
                active={activePage === "chat" && !activeThreadId}
                icon={item.icon}
                key={item.id}
                label="新对话"
                onClick={() => onOpenPage(item.id)}
              />
            ))}
          </nav>
        </div>

        {/* 会话列表 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          <div className="mt-2 flex min-h-0 flex-1 flex-col">
            <GroupHeader
              title="最近"
              expanded={recentExpanded}
              onToggle={() => setRecentExpanded((v) => !v)}
              action={
                <ThreadListPrimitive.New asChild>
                  <button
                    type="button"
                    className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                    title="新对话"
                  >
                    <Plus className="size-3.5" />
                  </button>
                </ThreadListPrimitive.New>
              }
            />
            <CollapseSection open={recentExpanded} scrollable>
              {chatHydrating || !chatHydrated ? (
                <SidebarLoadingState label="最近" />
              ) : (
                <div className="min-h-0 flex-1">
                  <ThreadList />
                </div>
              )}
            </CollapseSection>
          </div>
        </div>

        {/* 底部：设置 */}
        <div className="flex shrink-0 items-center justify-between border-t border-border/40 px-3 py-2">
          <button
            type="button"
            onClick={() => useSettingsUiStore.getState().openSettings()}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            title="设置"
          >
            <Settings className="size-4" />
          </button>
        </div>
      </div>
    </motion.aside>
  );
}

/** 可折叠分组标题行：标题+箭头在左，操作按钮在最右 */
function GroupHeader({
  title,
  expanded,
  onToggle,
  action,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-7 items-center justify-between px-1">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {title}
        <ChevronDown
          className={cn(
            "size-3 transition-transform duration-200",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {action}
    </div>
  );
}

/** 带高度动画的展开/收起容器 */
function CollapseSection({
  open,
  scrollable,
  children,
}: {
  open: boolean;
  scrollable?: boolean;
  children: React.ReactNode;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          {scrollable ? (
            <div className="app-scrollbar max-h-full overflow-y-auto">{children}</div>
          ) : (
            children
          )}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SidebarLoadingState({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 px-2 py-3">
      <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
