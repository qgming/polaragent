// 团队 tab 内容：团队列表 + 每个团队可展开的会话子列表
import { ChevronRight, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { cn } from "@/lib/utils";
import { TeamActionsMenu } from "@/components/team/TeamActionsMenu";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useTeamThreadsOf } from "@/stores/team/team-chat-store";

// 团队 tab 内容：每个团队可展开/收起其会话列表（参考「扩展」分组样式）
export function TeamList({
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
  const { t } = useTranslation("common");
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
	        {t("sidebar.noTeams")}
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
  const { t } = useTranslation("common");
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
          "group relative flex h-9 w-full items-center rounded-md px-2 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          type="button"
          className={cn(
            "flex w-full min-w-0 items-center gap-1.5 text-left font-medium transition-[padding] duration-150",
            running
              ? "pr-8 group-hover:pr-16 group-focus-within:pr-16"
              : "pr-0 group-hover:pr-8 group-focus-within:pr-8",
          )}
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
        <div
          className={cn(
            "pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0.5",
            "group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
          )}
        >
          <TeamActionsMenu
            teamName={team.name}
            onEdit={() => onEditTeam(team.id)}
            onClear={() => onClearTeam(team.id)}
            onDelete={() => onDeleteTeam(team.id)}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          />
          {running ? (
            <span
              className="flex size-6 shrink-0 items-center justify-center text-[#9b6fe0]"
	              title={t("sidebar.running")}
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
	            <span className="truncate">{t("sidebar.newSession")}</span>
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
  const { t } = useTranslation("common");
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
          "group relative flex h-8 w-full items-center rounded-md px-2 text-left text-sm transition-colors",
          active
            ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
            : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <button
          type="button"
          className={cn(
            "block w-full min-w-0 truncate text-left transition-[padding] duration-150",
            running
              ? "pr-7 group-hover:pr-14 group-focus-within:pr-14"
              : "pr-0 group-hover:pr-7 group-focus-within:pr-7",
          )}
          onClick={onClick}
        >
          {thread.title}
        </button>
        <div
          className={cn(
            "pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0.5",
            "group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-32">
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
	                {t("sidebar.rename")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
	                {t("delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {running ? (
            <span
              className="flex size-6 shrink-0 items-center justify-center text-[#9b6fe0]"
	              title={t("sidebar.running")}
            >
              <Loader2 className="size-3.5 animate-spin" />
            </span>
          ) : null}
        </div>
      </div>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent>
          <DialogHeader>
	            <DialogTitle>{t("sidebar.renameSessionTitle")}</DialogTitle>
	            <DialogDescription>{t("sidebar.renameSessionDescription")}</DialogDescription>
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
	                {t("cancel")}
              </Button>
            </DialogClose>
            <Button onClick={handleRename} type="button">
	              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
	            <DialogTitle>{t("sidebar.deleteSessionTitle")}</DialogTitle>
	            <DialogDescription>
	              {t("sidebar.deleteSessionDescription", { title: thread.title })}
	            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" type="button">
	                {t("cancel")}
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
	              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
