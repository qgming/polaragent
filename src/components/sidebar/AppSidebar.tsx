// 左侧栏：品牌头、主导航、项目/最近纵向分组、底部设置
// src/components/sidebar/AppSidebar.tsx

import { ChevronDown, Loader2, PanelLeftClose, Plus, Search, Settings } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  primaryNav,
  secondaryNav,
  type PageId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { useProjectsStore } from "@/stores/project/projects-store";
import { useSettingsUiStore } from "@/stores/settings-ui-store";
import { getUpdateStatus, isElectronRuntime } from "@/lib/electron/electron-api";
import { SidebarButton } from "./SidebarButton";
import { ExtensionNavGroup } from "./ExtensionNavGroup";
import { ThreadItem } from "./ThreadItem";
import { ProjectList } from "./ProjectList";
import logo from "@/assets/logo.png";

export function AppSidebar({
  activePage,
  activeThreadId,
  onOpenPage,
  onClearThread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  onToggleSidebar,
  onOpenSearch,
  onNewProjectThread,
  onEditProject,
  onDeleteProject,
  onClearProjectChats,
  onNewProject,
  runningThreadIds,
  threads,
}: {
  activePage: PageId;
  activeThreadId: string;
  onOpenPage: (page: PageId) => void;
  onClearThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSelectThread: (threadId: string) => void;
  onToggleSidebar: () => void;
  onOpenSearch: () => void;
  onNewProjectThread: (projectId: string) => void;
  onEditProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onClearProjectChats: (projectId: string) => void;
  onNewProject: () => void;
  runningThreadIds: string[];
  threads: Array<{ id: string; title: string; updatedAt: number }>;
}) {
  const { t } = useTranslation("nav");
  const chatHydrating = useChatStore((state) => state.hydrating);
  const chatHydrated = useChatStore((state) => state.hydrated);
  const projectsLoading = useProjectsStore((state) => state.isLoading);
  const [version, setVersion] = useState("");
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [recentExpanded, setRecentExpanded] = useState(true);

  useEffect(() => {
    if (!isElectronRuntime()) return;
    void getUpdateStatus()
      .then((s) => setVersion(s.currentVersion))
      .catch(() => {});
  }, []);

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
              title={t("titleBar.searchSessions")}
            >
              <Search className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={onToggleSidebar}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
              title={t("titleBar.closeSidebar")}
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
                active={
                  item.id === "chat"
                    ? activePage === "chat" && !activeThreadId
                    : activePage === item.id
                }
                icon={item.icon}
                key={item.id}
                label={t(`sidebar.${item.id}`)}
                onClick={() => onOpenPage(item.id)}
              />
            ))}
            <ExtensionNavGroup activePage={activePage} onOpenPage={onOpenPage} />
            {secondaryNav.map((item) => (
              <SidebarButton
                active={activePage === item.id}
                icon={item.icon}
                key={item.id}
                label={t(`sidebar.${item.id}`)}
                onClick={() => onOpenPage(item.id)}
              />
            ))}
          </nav>
        </div>

        {/* 列表区：项目 + 会话，各分组独立滚动 */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2">
          {/* 项目分组 */}
          <div className="mt-2 flex min-h-0 flex-col" style={{ flex: projectsExpanded ? "0 1 auto" : "0 0 auto" }}>
            <GroupHeader
              title={t("sidebar.projectTab")}
              expanded={projectsExpanded}
              onToggle={() => setProjectsExpanded((v) => !v)}
              action={
                <button
                  type="button"
                  onClick={onNewProject}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                  title={t("sidebar.projectTab")}
                >
                  <Plus className="size-3.5" />
                </button>
              }
            />
            <CollapseSection open={projectsExpanded} scrollable>
              {projectsLoading ? (
                <SidebarLoadingState label={t("sidebar.projectTab")} />
              ) : (
                <ProjectList
                  activeThreadId={activeThreadId}
                  onNewProjectThread={onNewProjectThread}
                  onSelectThread={onSelectThread}
                  onDeleteThread={onDeleteThread}
                  onRenameThread={onRenameThread}
                  onEditProject={onEditProject}
                  onDeleteProject={onDeleteProject}
                  onClearProjectChats={onClearProjectChats}
                  runningThreadIds={runningThreadIds}
                  onNewProject={onNewProject}
                />
              )}
            </CollapseSection>
          </div>

          {/* 会话分组 */}
          <div className="mt-2 flex min-h-0 flex-1 flex-col">
            <GroupHeader
              title={t("sidebar.tasks")}
              expanded={recentExpanded}
              onToggle={() => setRecentExpanded((v) => !v)}
              action={
                <button
                  type="button"
                  onClick={() => onOpenPage("chat")}
                  className="flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
                  title={t("sidebar.newChat")}
                >
                  <Plus className="size-3.5" />
                </button>
              }
            />
            <CollapseSection open={recentExpanded} scrollable>
              {chatHydrating || !chatHydrated ? (
                <SidebarLoadingState label={t("sidebar.tasks")} />
              ) : threads.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground/60">
                  {t("sidebar.newChat")}
                </p>
              ) : (
                <div className="space-y-0.5">
                  {threads.map((thread) => (
                    <ThreadItem
                      active={thread.id === activeThreadId && activePage === "chat"}
                      key={thread.id}
                      onClear={() => onClearThread(thread.id)}
                      onDelete={() => onDeleteThread(thread.id)}
                      onClick={() => onSelectThread(thread.id)}
                      onRename={(title) => onRenameThread(thread.id, title)}
                      running={runningThreadIds.includes(thread.id)}
                      thread={thread}
                    />
                  ))}
                </div>
              )}
            </CollapseSection>
          </div>
        </div>

        {/* 底部：设置 + 版本号 */}
        <div className="flex shrink-0 items-center justify-between border-t border-border/40 px-3 py-2">
          <button
            type="button"
            onClick={() => useSettingsUiStore.getState().openSettings()}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground dark:hover:bg-white/[0.08]"
            title={t("sidebar.settings")}
          >
            <Settings className="size-4" />
          </button>
          {version ? (
            <span className="text-[11px] text-muted-foreground/60">v{version}</span>
          ) : null}
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

/** 带高度动画的展开/收起容器；与 ProjectRow / ExtensionNavGroup 动画一致 */
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
