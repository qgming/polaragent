// 左侧栏：主导航、会话/项目 tab 切换与会话列表项
// src/components/sidebar/AppSidebar.tsx
//
// 列表项子组件拆分至同目录：SidebarButton / ThreadItem / ProjectList。

import { FolderOpen, Loader2, MessageCircle, Settings } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  primaryNav,
  secondaryNav,
  type PageId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chat-store";
import { useProjectsStore } from "@/stores/project/projects-store";
import { SidebarButton } from "./SidebarButton";
import { ExtensionNavGroup } from "./ExtensionNavGroup";
import { ThreadItem } from "./ThreadItem";
import { ProjectList } from "./ProjectList";

// tab 类型：会话 / 项目
export type SidebarTab = "tasks" | "project";

export function AppSidebar({
  activePage,
  activeThreadId,
  onOpenPage,
  onClearThread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  // 项目相关回调
  onNewProjectThread,
  onEditProject,
  onDeleteProject,
  onClearProjectChats,
  onNewProject,
  runningThreadIds,
  sidebarTab,
  setSidebarTab,
  threads,
}: {
  activePage: PageId;
  activeThreadId: string;
  onOpenPage: (page: PageId) => void;
  onClearThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSelectThread: (threadId: string) => void;
  // 项目相关回调
  onNewProjectThread: (projectId: string) => void;
  onEditProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onClearProjectChats: (projectId: string) => void;
  onNewProject: () => void;
  runningThreadIds: string[];
  sidebarTab: SidebarTab;
  setSidebarTab: (tab: SidebarTab) => void;
  // 普通对话列表（非项目对话）
  threads: Array<{ id: string; title: string; updatedAt: number }>;
}) {
  const { t } = useTranslation("nav");
  const chatHydrating = useChatStore((state) => state.hydrating);
  const chatHydrated = useChatStore((state) => state.hydrated);
  const projectsLoading = useProjectsStore((state) => state.isLoading);
  // 记录上一个 tab，用于推导内容横滑方向：切到右侧 tab → 内容从右进(+1)，反之 -1
  const tabOrder: SidebarTab[] = ["tasks", "project"];
  const prevTabRef = useRef(sidebarTab);
  const direction =
    tabOrder.indexOf(sidebarTab) >= tabOrder.indexOf(prevTabRef.current)
      ? 1
      : -1;
  useEffect(() => {
    prevTabRef.current = sidebarTab;
  }, [sidebarTab]);

  // tab 图标与标签映射
  const tabMeta: Record<SidebarTab, { Icon: typeof MessageCircle; label: string }> = {
    tasks: { Icon: MessageCircle, label: t("sidebar.tasks") },
    project: { Icon: FolderOpen, label: t("sidebar.projectTab") },
  };

  return (
    // 外层负责宽度开合动画（220 ⇄ 0），overflow-hidden 在收窄时裁掉内容；
    // 内层固定 220px 宽，避免内容被挤压换行。
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 240, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-background text-sidebar-foreground"
    >
      <div className="flex h-full w-[240px] flex-col">
        <div className="flex flex-col gap-3 p-3 pb-2">
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

          {/* 「扩展」折叠组：技能 / 工具 / 助手 */}
          <ExtensionNavGroup
            activePage={activePage}
            onOpenPage={onOpenPage}
          />

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

        {/* 两段 tab：会话 / 项目 */}
        <div className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5">
          {tabOrder.map((tab) => {
            const active = sidebarTab === tab;
            const { Icon, label } = tabMeta[tab];
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setSidebarTab(tab)}
                className={cn(
                  "relative flex h-6 items-center justify-center gap-1 rounded-[5px] px-2 text-xs font-medium whitespace-nowrap transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {active ? (
                  <motion.span
                    layoutId="sidebar-tab-indicator"
                    transition={{ type: "spring", stiffness: 500, damping: 38 }}
                    className="absolute inset-0 rounded-[5px] bg-card shadow-sm"
                  />
                ) : null}
                <span className="relative z-10 flex items-center gap-1">
                  <Icon className="size-3.5" />
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden px-3 pb-3">
        {/* 内容横滑：按切换方向从左/右进出，与 tab 高亮块联动 */}
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={sidebarTab}
            custom={direction}
            variants={{
              enter: (dir: number) => ({ x: dir * 40, opacity: 0 }),
              center: { x: 0, opacity: 1 },
              exit: (dir: number) => ({ x: dir * -40, opacity: 0 }),
            }}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 420, damping: 38 }}
            className="app-scrollbar h-full overflow-y-auto"
          >
            {sidebarTab === "tasks" ? (
              chatHydrating || !chatHydrated ? (
                <SidebarLoadingState label={t("sidebar.tasks")} />
              ) : (
                <div className="space-y-1">
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
              )
            ) : (
              projectsLoading ? (
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
              )
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="px-3 pb-3 pt-1">
        <nav className="space-y-1">
          <SidebarButton
            active={activePage === "settings"}
            icon={Settings}
            label={t("sidebar.settings")}
            onClick={() => onOpenPage("settings")}
          />
        </nav>
      </div>
      </div>
    </motion.aside>
  );
}

function SidebarLoadingState({ label }: { label: string }) {
  const { t } = useTranslation("common");

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-3 py-8 text-center">
      <div className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
      <p className="mt-3 text-sm font-medium text-foreground">{label}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t("loading")}</p>
    </div>
  );
}
