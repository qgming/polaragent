// 项目列表：在侧边栏「会话」tab 中显示项目列表，每个项目可展开/收起其对话子列表
import { Folder, FolderOpen, Loader2, MoreHorizontal, Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
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
import { useProjectsStore } from "@/stores/project/projects-store";
import { useChatStore } from "@/stores/chat-store";
import type { ProjectConfig } from "@/types/config";

// 项目列表 props
interface ProjectListProps {
  activeThreadId: string;
  onNewProjectThread: (projectId: string) => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onEditProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onClearProjectChats: (projectId: string) => void;
  runningThreadIds: string[];
  onNewProject: () => void;
}

export function ProjectList({
  activeThreadId,
  onNewProjectThread,
  onSelectThread,
  onDeleteThread,
  onRenameThread,
  onEditProject,
  onDeleteProject,
  onClearProjectChats,
  runningThreadIds,
  onNewProject,
}: ProjectListProps) {
  const { t } = useTranslation("common");
  const projects = useProjectsStore((state) => state.projects);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // 当前对话所在的项目默认展开
  useEffect(() => {
    const thread = useChatStore.getState().threads.find((t) => t.id === activeThreadId);
    if (thread?.projectId) {
      setExpanded((prev) => {
        if (prev.has(thread.projectId!)) return prev;
        const next = new Set(prev);
        next.add(thread.projectId!);
        return next;
      });
    }
  }, [activeThreadId]);

  const toggle = (projectId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  if (projects.length === 0) {
    return (
      <div className="flex items-center justify-center px-2 py-4 text-center text-sm text-muted-foreground">
        <button
          type="button"
          onClick={onNewProject}
          className="hover:text-foreground hover:underline"
        >
          {t("sidebar.noProjects")}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-0.5">
      {projects.map((project) => (
        <ProjectRow
          key={project.id}
          project={project}
          open={expanded.has(project.id)}
          activeThreadId={activeThreadId}
          onToggle={() => toggle(project.id)}
          onNewThread={() => onNewProjectThread(project.id)}
          onSelectThread={onSelectThread}
          onDeleteThread={onDeleteThread}
          onRenameThread={onRenameThread}
          onEditProject={() => onEditProject(project.id)}
          onDeleteProject={() => onDeleteProject(project.id)}
          onClearProjectChats={() => onClearProjectChats(project.id)}
          runningThreadIds={runningThreadIds}
        />
      ))}
      {/* 新建项目按钮 */}
      <button
        type="button"
        onClick={onNewProject}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="truncate">{t("sidebar.newProject")}</span>
      </button>
    </div>
  );
}

// 单个项目行 + 其对话子列表（展开态）
function ProjectRow({
  project,
  open,
  activeThreadId,
  onToggle,
  onNewThread,
  onSelectThread,
  onDeleteThread,
  onRenameThread,
  onEditProject,
  onDeleteProject,
  onClearProjectChats,
  runningThreadIds,
}: {
  project: ProjectConfig;
  open: boolean;
  activeThreadId: string;
  onToggle: () => void;
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onRenameThread: (threadId: string, title: string) => void;
  onEditProject: () => void;
  onDeleteProject: () => void;
  onClearProjectChats: () => void;
  runningThreadIds: string[];
}) {
  const { t } = useTranslation("common");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  // 订阅该项目下的对话
  const threads = useProjectThreadsOf(project.id);
  const running = threads.some((thread) =>
    runningThreadIds.includes(thread.id),
  );

  return (
    <div>
      {/* 项目行：点击展开/收起；chevron 指示状态；hover 出「更多」 */}
      <div
        className={cn(
          "group relative flex h-9 w-full items-center rounded-md px-2 text-left text-sm transition-colors",
          // 如果当前对话属于该项目，高亮
          threads.some((t) => t.id === activeThreadId)
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
          {open ? (
            <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <Folder className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate">{project.name}</span>
        </button>
        <div
          className={cn(
            "pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center justify-end gap-0.5",
            "group-hover:pointer-events-auto group-focus-within:pointer-events-auto",
          )}
        >
          <button
            type="button"
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              onNewThread();
            }}
            title={t("sidebar.newChat")}
          >
            <Plus className="size-4" />
          </button>
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
              <DropdownMenuItem onSelect={onEditProject}>
                {t("sidebar.editProject")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setClearOpen(true)}>
                {t("sidebar.clearProjectChats")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setDeleteOpen(true)}
              >
                {t("sidebar.deleteProject")}
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

      {/* 对话子列表：缩进 + 左侧竖直引导线，展开/收起带高度动画 */}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="ml-[15px] border-l border-border pl-2">
              {threads.map((thread) => (
                <ProjectThreadItem
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  running={runningThreadIds.includes(thread.id)}
                  onClick={() => onSelectThread(thread.id)}
                  onRename={(title) => onRenameThread(thread.id, title)}
                  onDelete={() => onDeleteThread(thread.id)}
                />
              ))}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {/* 删除项目确认弹窗 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sidebar.deleteProjectTitle")}</DialogTitle>
            <DialogDescription>
              {t("sidebar.deleteProjectDescription", { name: project.name })}
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
                onDeleteProject();
                setDeleteOpen(false);
              }}
            >
              {t("delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 清空项目会话确认弹窗 */}
      <Dialog open={clearOpen} onOpenChange={setClearOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sidebar.clearProjectChatsTitle")}</DialogTitle>
            <DialogDescription>
              {t("sidebar.clearProjectChatsDescription", { name: project.name })}
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
                onClearProjectChats();
                setClearOpen(false);
              }}
            >
              {t("sidebar.clearProjectChats")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// 项目对话子项（保持侧栏会话项样式，但更简洁——只有重命名和删除）
function ProjectThreadItem({
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
            <DialogTitle>{t("sidebar.renameChatTitle")}</DialogTitle>
            <DialogDescription>{t("sidebar.renameChatDescription")}</DialogDescription>
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
            <DialogTitle>{t("sidebar.deleteChatTitle")}</DialogTitle>
            <DialogDescription>
              {t("sidebar.deleteChatDescription", { title: thread.title })}
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

// --- 自定义 hook：获取某项目下的会话摘要 ---

interface ProjectThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}

/** 某项目下的会话列表（轻量摘要，按更新时间倒序）。
 *  与 useThreadSummaries 使用相同的 JSON 签名策略——仅当签名值真正变化时触发重渲染。
 *  注意：zustand selector 会在 threads 引用变化时重执行 filter+map+stringify，
 *  但由于返回值是 primitive string，引用稳定时不触发组件重渲染。 */
function useProjectThreadsOf(projectId: string): ProjectThreadSummary[] {
  const signature = useChatStore((state) =>
    JSON.stringify(
      state.threads
        .filter((t) => t.projectId === projectId)
        .map((t) => [t.id, t.title, t.updatedAt]),
    ),
  );
  return useMemo(() => {
    const rows = JSON.parse(signature) as Array<[string, string, number]>;
    return rows
      .map(([id, title, updatedAt]) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [signature]);
}
