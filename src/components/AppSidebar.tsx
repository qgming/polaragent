// 左侧栏：主导航、对话/团队切换与会话列表项
// src/components/AppSidebar.tsx

import { ChevronRight, Loader2, MessageSquare, MoreHorizontal, Plus, Settings, Users } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  primaryNav,
  type IconComponent,
  type PageId,
} from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { TeamActionsMenu } from "@/components/TeamActionsMenu";
import { useTeamsStore } from "@/stores/teams-store";
import { useTeamThreadsOf } from "@/stores/team-chat-store";

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
              label={item.label}
              onClick={() => onOpenPage(item.id)}
            />
          ))}
        </nav>

        {/* 分段控件：选中高亮块用 layoutId 在两 tab 间平滑滑动 */}
        <div className="grid grid-cols-2 gap-0.5 rounded-md bg-muted p-0.5">
          {tabOrder.map((tab) => {
            const active = sidebarTab === tab;
            const Icon = tab === "tasks" ? MessageSquare : Users;
            const label = tab === "tasks" ? "对话" : "团队";
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
            label="设置"
            onClick={() => onOpenPage("settings")}
          />
        </nav>
      </div>
      </div>
    </motion.aside>
  );
}

function SidebarButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: IconComponent;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        active
          ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
          : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}

// 团队 tab 内容：每个团队可展开/收起其会话列表（参考「扩展」分组样式）
function TeamList({
  activeTeamId,
  activeTeamThreadId,
  onEditTeam,
  onClearTeam,
  onDeleteTeam,
  onSelectTeamThread,
  onNewTeamThread,
  onRenameTeamThread,
  onDeleteTeamThread,
  runningTeamThreadIds,
}: {
  activeTeamId?: string;
  activeTeamThreadId?: string;
  onEditTeam: (teamId: string) => void;
  onClearTeam: (teamId: string) => void;
  onDeleteTeam: (teamId: string) => void;
  onSelectTeamThread: (teamId: string, threadId: string) => void;
  onNewTeamThread: (teamId: string) => void;
  onRenameTeamThread: (threadId: string, title: string) => void;
  onDeleteTeamThread: (threadId: string) => void;
  runningTeamThreadIds: string[];
}) {
  const teams = useTeamsStore((state) => state.teams);
  // 展开的团队 id 集合（点团队名切换展开/收起）
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 当前所在团队默认展开一次，便于看到其会话
  useEffect(() => {
    if (activeTeamId) {
      setExpanded((prev) => {
        if (prev.has(activeTeamId)) return prev;
        const next = new Set(prev);
        next.add(activeTeamId);
        return next;
      });
    }
  }, [activeTeamId]);

  if (teams.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-2 text-center text-sm text-muted-foreground">
        还没有团队，去「团队」页新建一个
      </div>
    );
  }

  const toggle = (teamId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(teamId)) next.delete(teamId);
      else next.add(teamId);
      return next;
    });
  };

  return (
    <div className="space-y-0.5">
      {teams.map((team) => (
        <TeamRow
          key={team.id}
          team={team}
          open={expanded.has(team.id)}
          active={team.id === activeTeamId}
          activeTeamThreadId={activeTeamThreadId}
          onToggle={() => toggle(team.id)}
          onEditTeam={onEditTeam}
          onClearTeam={onClearTeam}
          onDeleteTeam={onDeleteTeam}
          onSelectTeamThread={onSelectTeamThread}
          onNewTeamThread={onNewTeamThread}
          onRenameTeamThread={onRenameTeamThread}
          onDeleteTeamThread={onDeleteTeamThread}
          runningTeamThreadIds={runningTeamThreadIds}
        />
      ))}
    </div>
  );
}

// 单个团队行 + 其会话子列表（展开态）
function TeamRow({
  team,
  open,
  active,
  activeTeamThreadId,
  onToggle,
  onEditTeam,
  onClearTeam,
  onDeleteTeam,
  onSelectTeamThread,
  onNewTeamThread,
  onRenameTeamThread,
  onDeleteTeamThread,
  runningTeamThreadIds,
}: {
  team: { id: string; name: string; avatar: string };
  open: boolean;
  active: boolean;
  activeTeamThreadId?: string;
  onToggle: () => void;
  onEditTeam: (teamId: string) => void;
  onClearTeam: (teamId: string) => void;
  onDeleteTeam: (teamId: string) => void;
  onSelectTeamThread: (teamId: string, threadId: string) => void;
  onNewTeamThread: (teamId: string) => void;
  onRenameTeamThread: (threadId: string, title: string) => void;
  onDeleteTeamThread: (threadId: string) => void;
  runningTeamThreadIds: string[];
}) {
  // 仅展开时才订阅该团队的会话列表，避免无谓重渲染
  const threads = useTeamThreadsOf(team.id);
  const running = threads.some((thread) =>
    runningTeamThreadIds.includes(thread.id),
  );

  return (
    <div>
      {/* 团队行：点击展开/收起；chevron 指示状态；hover 出「更多」 */}
      <div
        className={cn(
          "group grid h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 text-left font-medium"
          onClick={onToggle}
        >
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
          <span className="shrink-0 text-base leading-none">
            {team.avatar || "👥"}
          </span>
          <span className="truncate">{team.name}</span>
        </button>
        <div className="flex items-center justify-end gap-0.5">
          <TeamActionsMenu
            teamName={team.name}
            onEdit={() => onEditTeam(team.id)}
            onClear={() => onClearTeam(team.id)}
            onDelete={() => onDeleteTeam(team.id)}
            className="opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100"
          />
          {running ? (
            <span
              className="flex size-6 shrink-0 items-center justify-center text-[#9b6fe0]"
              title="后台运行中"
            >
              <Loader2 className="size-3.5 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>

      {/* 会话子列表：缩进 + 左侧竖直引导线 */}
      {open ? (
        <div className="ml-[15px] border-l border-border pl-2">
          <button
            type="button"
            onClick={() => onNewTeamThread(team.id)}
            className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="truncate">新建会话</span>
          </button>
          {threads.map((thread) => (
            <TeamThreadItem
              key={thread.id}
              thread={thread}
              active={thread.id === activeTeamThreadId}
              running={runningTeamThreadIds.includes(thread.id)}
              onClick={() => onSelectTeamThread(team.id, thread.id)}
              onRename={(title) => onRenameTeamThread(thread.id, title)}
              onDelete={() => onDeleteTeamThread(thread.id)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// 团队会话子项：点击进入；hover 出「更多」（重命名/删除该会话）
function TeamThreadItem({
  thread,
  active,
  running,
  onClick,
  onRename,
  onDelete,
}: {
  thread: { id: string; title: string; updatedAt: number };
  active: boolean;
  running: boolean;
  onClick: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title);

  useEffect(() => {
    setDraftTitle(thread.title);
  }, [thread.title]);

  const handleRename = () => {
    onRename(draftTitle);
    setRenameOpen(false);
  };

  return (
    <>
      <div
        className={cn(
          "group grid h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-1 rounded-md px-2 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          type="button"
          className="min-w-0 truncate text-left"
          onClick={onClick}
        >
          {thread.title}
        </button>
        <div className="flex items-center justify-end gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {running ? (
            <span
              className="flex size-6 shrink-0 items-center justify-center text-[#9b6fe0]"
              title="后台运行中"
            >
              <Loader2 className="size-3.5 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
            <DialogDescription>修改后会立即更新侧边栏里的会话名称。</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleRename();
              }
            }}
            value={draftTitle}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                取消
              </Button>
            </DialogClose>
            <Button onClick={handleRename} type="button">
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              确定删除「{thread.title}」吗？此操作会移除该团队会话及其历史，不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              type="button"
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ThreadItem({
  active,
  onClear,
  onDelete,
  onClick,
  onRename,
  running,
  thread,
}: {
  active: boolean;
  onClear: () => void;
  onDelete: () => void;
  onClick: () => void;
  onRename: (title: string) => void;
  running: boolean;
  thread: { id: string; title: string; updatedAt: number };
}) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [draftTitle, setDraftTitle] = useState(thread.title);

  useEffect(() => {
    setDraftTitle(thread.title);
  }, [thread.title]);

  const handleRename = () => {
    onRename(draftTitle);
    setRenameOpen(false);
  };

  return (
    <>
      <div
        className={cn(
          "group grid h-9 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md px-3 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          className="min-w-0 truncate text-left font-medium"
          onClick={onClick}
          type="button"
        >
          {thread.title}
        </button>
        {/* 右侧操作区：运行中常驻旋转图标，hover 整行时「更多」按钮从其左侧滑出；
            未运行时仅 hover 才显示「更多」按钮（与原行为一致）。 */}
        <div className="flex items-center justify-end gap-0.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-background hover:text-foreground data-[state=open]:opacity-100",
                  "opacity-0 group-hover:opacity-100",
                )}
                type="button"
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                重命名
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setClearOpen(true)}>
                清空对话
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {running ? (
            <span
              className="flex size-7 shrink-0 items-center justify-center text-[#9b6fe0]"
              title="后台运行中"
            >
              <Loader2 className="size-4 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>重命名对话</DialogTitle>
            <DialogDescription>
              修改后会立即更新侧边栏里的对话名称。
            </DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
            onChange={(event) => setDraftTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleRename();
              }
            }}
            value={draftTitle}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                取消
              </Button>
            </DialogClose>
            <Button onClick={handleRename} type="button">
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除对话</DialogTitle>
            <DialogDescription>
              确定删除「{thread.title}」吗？此操作会从当前列表移除该对话。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onDelete();
                setDeleteOpen(false);
              }}
              type="button"
            >
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清空对话</DialogTitle>
            <DialogDescription>
              确定清空「{thread.title}」的所有消息吗？会话与所选助手会保留，方便继续与该助手开始新对话。此操作不可撤销。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
                取消
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                onClear();
                setClearOpen(false);
              }}
              type="button"
            >
              清空
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
