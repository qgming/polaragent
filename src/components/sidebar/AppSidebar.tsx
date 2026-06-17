// 左侧栏：主导航、对话/团队切换与会话列表项
// src/components/sidebar/AppSidebar.tsx
//
// 列表项子组件拆分至同目录：SidebarButton / ThreadItem / TeamList。

import { MessageCircle, Settings, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";

import {
  primaryNav,
  secondaryNav,
  type PageId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { SidebarButton } from "./SidebarButton";
import { ExtensionNavGroup } from "./ExtensionNavGroup";
import { ThreadItem } from "./ThreadItem";
import { TeamList } from "./TeamList";

export function AppSidebar({
  activePage,
  activeThreadId,
  activeTeamId,
  activeTeamThreadId,
  onOpenPage,
  onClearThread,
  onDeleteThread,
  onRenameThread,
  onSelectThread,
  onEditTeam,
  onClearTeam,
  onDeleteTeam,
  onSelectTeamThread,
  onNewTeamThread,
  onRenameTeamThread,
  onDeleteTeamThread,
  runningThreadIds,
  runningTeamThreadIds,
  sidebarTab,
  setSidebarTab,
  threads,
}: {
  activePage: PageId;
  activeThreadId: string;
  // 当前激活的团队（处于团队聊天页时）——用于高亮侧边栏团队项
  activeTeamId?: string;
  // 当前激活的团队会话 id——用于高亮展开列表里的会话子项
  activeTeamThreadId?: string;
  onOpenPage: (page: PageId) => void;
  onClearThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onSelectThread: (threadId: string) => void;
  // 团队相关回调（团队 tab 列表项）
  onEditTeam: (teamId: string) => void;
  onClearTeam: (teamId: string) => void;
  onDeleteTeam: (teamId: string) => void;
  // 团队会话子项回调
  onSelectTeamThread: (teamId: string, threadId: string) => void;
  onNewTeamThread: (teamId: string) => void;
  onRenameTeamThread: (threadId: string, title: string) => void;
  onDeleteTeamThread: (threadId: string) => void;
  runningThreadIds: string[];
  runningTeamThreadIds: string[];
  sidebarTab: "tasks" | "team";
  setSidebarTab: (tab: "tasks" | "team") => void;
  threads: Array<{ id: string; title: string; updatedAt: number }>;
}) {
  const { t } = useTranslation("nav");
  // 记录上一个 tab，用于推导内容横滑方向：切到右侧 tab → 内容从右进(+1)，反之 -1
  const tabOrder: Array<"tasks" | "team"> = ["tasks", "team"];
  const prevTabRef = useRef(sidebarTab);
  const direction =
    tabOrder.indexOf(sidebarTab) >= tabOrder.indexOf(prevTabRef.current)
      ? 1
      : -1;
  useEffect(() => {
    prevTabRef.current = sidebarTab;
  }, [sidebarTab]);

  return (
    // 外层负责宽度开合动画（220 ⇄ 0），overflow-hidden 在收窄时裁掉内容；
    // 内层固定 220px 宽，避免内容被挤压换行。
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: 220, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="flex shrink-0 flex-col overflow-hidden border-r border-border bg-background text-sidebar-foreground"
    >
      <div className="flex h-full w-[220px] flex-col">
        <div className="flex flex-col gap-3 p-3 pb-2">
        <nav className="space-y-1">
          {primaryNav.map((item) => (
            <SidebarButton
              active={
                item.id === "chat"
                  ? activePage === "chat" && !activeThreadId && !activeTeamId
                  : activePage === item.id && !activeTeamId
              }
              icon={item.icon}
              key={item.id}
              label={t(`sidebar.${item.id}`)}
              onClick={() => onOpenPage(item.id)}
            />
          ))}

          {/* 「扩展」折叠组：技能 / 工具 / 助手 / 团队 */}
          <ExtensionNavGroup
            activePage={activePage}
            activeTeamId={activeTeamId}
            onOpenPage={onOpenPage}
          />

          {secondaryNav.map((item) => (
            <SidebarButton
              active={activePage === item.id && !activeTeamId}
              icon={item.icon}
              key={item.id}
              label={t(`sidebar.${item.id}`)}
              onClick={() => onOpenPage(item.id)}
            />
          ))}
        </nav>

        {/* 分段控件：选中高亮块用 layoutId 在两 tab 间平滑滑动 */}
        <div className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5">
          {tabOrder.map((tab) => {
            const active = sidebarTab === tab;
            const Icon = tab === "tasks" ? MessageCircle : Users;
            const label = tab === "tasks" ? t("sidebar.tasks") : t("sidebar.teamTab");
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setSidebarTab(tab)}
                className={cn(
                  "relative flex h-6 items-center justify-center gap-1 rounded-[5px] px-3 text-xs font-medium whitespace-nowrap transition-colors",
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
            ) : (
              <TeamList
                activeTeamId={activeTeamId}
                activeTeamThreadId={activeTeamThreadId}
                onEditTeam={onEditTeam}
                onClearTeam={onClearTeam}
                onDeleteTeam={onDeleteTeam}
                onSelectTeamThread={onSelectTeamThread}
                onNewTeamThread={onNewTeamThread}
                onRenameTeamThread={onRenameTeamThread}
                onDeleteTeamThread={onDeleteTeamThread}
                runningTeamThreadIds={runningTeamThreadIds}
              />
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
