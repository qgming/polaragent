// 团队监控面板 —— 与普通对话侧边栏结构一致

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Loader2,
} from "lucide-react";

import { WorkspaceTree } from "@/components/WorkspaceTree";
import { fileIconFor } from "@/lib/file-icons";
import { isPreviewable, openPreviewWindow } from "@/lib/preview";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/config-store";
import {
  useTeamChatStore,
  useTeamThreadMessages,
} from "@/stores/team/team-chat-store";
import { useResponsivePanelWidth } from "@/hooks/useResponsiveWidth";
import { useTeamsStore } from "@/stores/team/teams-store";
import {
  useTeamMonitorStore,
  type ArtifactItem,
  type TodoItem,
} from "@/stores/team/team-monitor-store";

export function TeamMonitorPanel({
  threadId,
  teamId,
  sessionFilesDir,
}: {
  threadId: string;
  teamId: string;
  sessionFilesDir?: string;
}) {
  const { t } = useTranslation("team");
  const team = useTeamsStore((state) =>
    state.teams.find((t) => t.id === teamId),
  );
  const agents = useConfigStore((state) => state.agents);
  const monitor = useTeamMonitorStore((state) => state.byThread[threadId]);
  const messages = useTeamThreadMessages(threadId);
  const threadWorkingDir = useTeamChatStore(
    (state) => state.threads.find((t) => t.id === threadId)?.workingDir,
  );

  const todos = monitor?.todos ?? [];
  const artifacts = monitor?.artifacts ?? [];
  const workingDir =
    monitor?.workingDir || threadWorkingDir || team?.workspaceDir || "";
  const finalFiles = artifacts.filter((item) => item.kind === "final");
  const workingFiles = artifacts.filter((item) => item.kind === "working");
  const completedTodos = todos.filter(
    (todo) => todo.status === "completed",
  ).length;
  const panelWidth = useResponsivePanelWidth();

  // 成员信息映射
  const memberInfo = useMemo(() => {
    const map = new Map<string, { avatar: string; name: string }>();
    for (const id of team?.memberIds ?? []) {
      const agent = agents.find((a) => a.id === id);
      if (agent) {
        map.set(id, { avatar: agent.avatar || "⚡", name: agent.name });
      }
    }
    return map;
  }, [team?.memberIds, agents]);

  // 最近一次投票消息（进行中或已完成）
  const latestVote = useMemo(() => {
    return messages
      .slice()
      .reverse()
      .find((m) => m.vote);
  }, [messages]);
  const voteStatusBadge = useMemo(() => {
    const vote = latestVote?.vote;
    if (!vote) return undefined;

    if (vote.status === "completed") {
      return {
        label: t("monitor.vote.completed"),
        className: "bg-green-500/10 text-green-700 dark:text-green-300",
      };
    }
    if (vote.status === "cancelled") {
      return {
        label: t("monitor.vote.cancelled"),
        className: "bg-red-500/10 text-red-700 dark:text-red-300",
      };
    }

    const votedCount = (vote.memberStatuses ?? []).filter(
      (item) => item.status === "voted",
    ).length;
    return {
      label: t("monitor.vote.inProgress", { voted: votedCount, total: memberInfo.size }),
      className: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
    };
  }, [latestVote?.vote, memberInfo.size, t]);

  return (
    <motion.aside
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: panelWidth, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 36 }}
      className="flex shrink-0 flex-col overflow-hidden border-l border-border bg-background"
    >
      <div className="flex h-full flex-col pt-2" style={{ width: panelWidth }}>
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto pb-3">
          {/* 待办 */}
          <Section
            title={t("monitor.sections.todos")}
            count={
              todos.length > 0 ? `${completedTodos}/${todos.length}` : undefined
            }
          >
            {todos.length > 0 ? (
              <ul className="space-y-0.5">
                {todos.map((todo) => (
                  <TodoRow key={todo.id} todo={todo} />
                ))}
              </ul>
            ) : (
              <EmptyHint text={t("monitor.empty.todos")} />
            )}
          </Section>

          {/* 投票 */}
          <Section
            title={t("monitor.sections.votes")}
            count={voteStatusBadge?.label}
            countClassName={voteStatusBadge?.className}
          >
            <div className="px-3">
              {latestVote?.vote ? (
                <VoteList vote={latestVote.vote} memberInfo={memberInfo} />
              ) : (
                <EmptyHint text={t("monitor.empty.votes")} />
              )}
            </div>
          </Section>

          {/* 产物 */}
          <Section title={t("monitor.sections.artifacts")}>
            <ArtifactsTabs
              finalFiles={finalFiles}
              workingFiles={workingFiles}
              workingDir={workingDir}
              sessionFilesDir={sessionFilesDir}
            />
          </Section>
        </div>
      </div>
    </motion.aside>
  );
}

// Section 组件
function Section({
  title,
  count,
  countClassName,
  children,
}: {
  title: string;
  count?: string;
  countClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);

  return (
    <section className="border-b border-dashed border-border/70 py-2 last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-3 py-1 text-left"
      >
        <span className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
          {title}
          {count ? (
            <span
              className={cn(
                "rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground",
                countClassName,
              )}
            >
              {count}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            !open && "-rotate-90",
          )}
        />
      </button>
      {open ? <div className="mt-0.5">{children}</div> : null}
    </section>
  );
}

// EmptyHint 组件
function EmptyHint({ text }: { text: string }) {
  return (
    <div className="flex min-h-[60px] items-center justify-center px-3 text-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}

function TodoRow({ todo }: { todo: TodoItem }) {
  return (
    <li className="flex items-start gap-2 rounded-md px-3 py-1 text-sm">
      <span className="mt-0.5 shrink-0">
        {todo.status === "completed" ? (
          <CheckCircle2 className="size-4 text-[#9b6fe0]" />
        ) : todo.status === "in_progress" ? (
          <Loader2 className="size-4 animate-spin text-[#9b6fe0]" />
        ) : (
          <CircleDashed className="size-4 text-muted-foreground" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 leading-5",
          todo.status === "completed"
            ? "text-muted-foreground line-through"
            : todo.status === "in_progress"
              ? "font-medium text-foreground"
              : "text-sidebar-foreground",
        )}
      >
        {todo.content}
      </span>
    </li>
  );
}

function ArtifactsTabs({
  finalFiles,
  workingFiles,
  workingDir,
  sessionFilesDir,
}: {
  finalFiles: ArtifactItem[];
  workingFiles: ArtifactItem[];
  workingDir?: string;
  sessionFilesDir?: string;
}) {
  const { t } = useTranslation("team");
  // 判断是否选择了工作目录（非临时目录）
  const hasWorkingDir = workingDir && workingDir !== sessionFilesDir;
  // 动态 tab 列表：有工作目录时显示「final + workspace」，无则显示「final + session」
  const availableTabs: Array<"final" | "workspace" | "session"> = hasWorkingDir
    ? ["final", "workspace"]
    : ["final", "session"];

  const [tab, setTab] = useState<"final" | "workspace" | "session">("final");
  const prevTabRef = useRef(tab);
  const direction =
    availableTabs.indexOf(tab) >= availableTabs.indexOf(prevTabRef.current)
      ? 1
      : -1;

  useEffect(() => {
    prevTabRef.current = tab;
  }, [tab]);

  // 当 tab 列表变化时（工作目录切换），确保当前 tab 在可用列表中
  useEffect(() => {
    if (!availableTabs.includes(tab)) {
      setTab("final");
    }
  }, [availableTabs, tab]);

  return (
    <div className="px-3">
      <div className={cn(
        "grid gap-0.5 rounded-md bg-muted p-0.5",
        availableTabs.length === 2 ? "grid-cols-2" : "grid-cols-3"
      )}>
	        {availableTabs.map((value) => {
	          const active = tab === value;
	          const label = value === "final" ? t("monitor.tabs.final") : value === "workspace" ? t("monitor.tabs.workspace") : t("monitor.tabs.session");
          return (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={cn(
                "relative flex h-6 items-center justify-center rounded-[5px] px-2 text-xs font-medium whitespace-nowrap transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="team-artifact-tab-indicator"
                  transition={{ type: "spring", stiffness: 500, damping: 38 }}
                  className="absolute inset-0 rounded-[5px] bg-card shadow-sm"
                />
              ) : null}
              <span className="relative z-10">{label}</span>
            </button>
          );
        })}
      </div>

      <div className="relative mt-2 overflow-hidden">
        <AnimatePresence mode="popLayout" initial={false} custom={direction}>
          <motion.div
            key={tab}
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
            className="-mx-3"
          >
            {tab === "final" ? (
              finalFiles.length > 0 || workingFiles.length > 0 ? (
                <div className="space-y-1.5">
                  {finalFiles.length > 0 ? (
	                    <ArtifactGroup
	                      label={t("monitor.artifactGroups.final")}
                      files={finalFiles}
                      workingDir={workingDir}
                    />
                  ) : null}
                  {workingFiles.length > 0 ? (
	                    <ArtifactGroup
	                      label={t("monitor.artifactGroups.working")}
                      files={workingFiles}
                      workingDir={workingDir}
                    />
                  ) : null}
                </div>
              ) : (
	                <EmptyHint text={t("monitor.empty.artifacts")} />
              )
            ) : tab === "workspace" ? (
              workingDir ? (
                <WorkspaceTree rootDir={workingDir} />
              ) : (
	                <EmptyHint text={t("monitor.empty.noWorkspace")} />
              )
            ) : sessionFilesDir ? (
              <WorkspaceTree rootDir={sessionFilesDir} />
            ) : (
	              <EmptyHint text={t("monitor.empty.noSessionDir")} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ArtifactGroup({
  label,
  files,
  workingDir,
}: {
  label: string;
  files: ArtifactItem[];
  workingDir?: string;
}) {
  const { t } = useTranslation("team");
  return (
    <div>
      <p className="mb-0.5 px-3 text-xs text-muted-foreground">{label}</p>
      <ul className="space-y-1">
        {files.map((file) => {
          const Icon = fileIconFor(file.name);
          const previewable = isPreviewable(file.name);
          const absolutePath = resolvePath(file.path, workingDir);

          return (
            <li key={file.path} className="px-3">
              <button
                type="button"
                onClick={
                  previewable
                    ? () => void openPreviewWindow(absolutePath)
                    : undefined
                }
                disabled={!previewable}
                className={cn(
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-0.5 text-left text-sm text-sidebar-foreground transition-colors",
                  previewable
                    ? "cursor-pointer hover:bg-muted hover:text-foreground"
                    : "cursor-default",
                )}
	                title={previewable ? t("monitor.previewTitle", { path: absolutePath }) : absolutePath}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{file.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function resolvePath(path: string, workingDir?: string): string {
  if (!workingDir) return path;
  const isAbsolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  if (isAbsolute) return path;
  const base = workingDir.replace(/[\\/]+$/, "");
  return `${base}/${path}`;
}

// VoteList 组件 - 显示最近一次成员投票
function VoteList({
  vote,
  memberInfo,
}: {
  vote: NonNullable<NonNullable<ReturnType<typeof useTeamThreadMessages>>[number]["vote"]>;
  memberInfo: Map<string, { avatar: string; name: string }>;
}) {
  const memberStatuses = vote.memberStatuses ?? [];
  const isCompleted = vote.status === "completed";
  const isCancelled = vote.status === "cancelled";

  return (
    <div className="pt-1">
      <div className="mb-2">
        <div className="min-w-0 text-xs font-medium leading-5 text-foreground">
          {vote.topic}
        </div>
      </div>

      <VoteResultList vote={vote} memberInfo={memberInfo} />
      {!isCompleted && !isCancelled ? (
        <div className="mt-2">
          <VoteProgressList
            statuses={memberStatuses}
            memberInfo={memberInfo}
          />
        </div>
      ) : null}
    </div>
  );
}

function VoteProgressList({
  statuses,
  memberInfo,
}: {
  statuses: NonNullable<
    NonNullable<ReturnType<typeof useTeamThreadMessages>>[number]["vote"]
  >["memberStatuses"];
  memberInfo: Map<string, { avatar: string; name: string }>;
}) {
  const { t } = useTranslation("team");
  if (!statuses || statuses.length === 0) {
    return (
      <div className="rounded-md bg-muted/40 px-2 py-2 text-xs text-muted-foreground">
        {t("monitor.vote.waiting")}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {statuses.map((item) => {
        const info = memberInfo.get(item.agentId);
        const label =
          item.status === "voting"
            ? t("monitor.vote.voting")
            : item.status === "voted"
              ? t("monitor.vote.voted")
              : item.status === "failed"
                ? t("monitor.vote.failed")
                : t("monitor.vote.pending");
        return (
          <span
            key={item.agentId}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-xs",
              item.status === "voting"
                ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : item.status === "voted"
                  ? "bg-green-500/10 text-green-700 dark:text-green-300"
                  : item.status === "failed"
                    ? "bg-red-500/10 text-red-700 dark:text-red-300"
                    : "bg-muted text-sidebar-foreground",
            )}
            title={item.error}
          >
            <span className="shrink-0 leading-none">
              {info?.avatar ?? "⚡"}
            </span>
            <span className="truncate">{info?.name ?? t("monitor.unknownMember")}</span>
            <span className="shrink-0 opacity-80">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

function VoteResultList({
  vote,
  memberInfo,
}: {
  vote: NonNullable<NonNullable<ReturnType<typeof useTeamThreadMessages>>[number]["vote"]>;
  memberInfo: Map<string, { avatar: string; name: string }>;
}) {
  const { t } = useTranslation("team");
  return (
    <div className="space-y-1.5">
      {vote.options.map((option) => {
        const optionVotes = vote.votes.filter((v) => v.optionId === option.id);
        const isTopOption =
          vote.status === "completed" &&
          (vote.result?.topOptionIds ?? []).includes(option.id);

        return (
          <div
            key={option.id}
            className={cn(
              "rounded-md border border-dashed border-border/70 px-2 py-2",
              isTopOption && "bg-green-500/10",
            )}
          >
            <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
              <span className="min-w-0 truncate font-medium text-foreground">
                {option.label}
              </span>
	              <span className="shrink-0 text-muted-foreground">
	                {t("monitor.vote.voteCount", { count: optionVotes.length })}
	              </span>
            </div>
            {optionVotes.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {optionVotes.map((item) => {
                  const info = memberInfo.get(item.agentId);
                  return (
                    <span
                      key={`${item.agentId}-${item.timestamp}`}
                      className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-sidebar-foreground"
                    >
                      <span className="shrink-0 leading-none">
                        {info?.avatar ?? "⚡"}
                      </span>
	                      <span className="truncate">{info?.name ?? t("monitor.unknownMember")}</span>
                    </span>
                  );
                })}
              </div>
            ) : (
	              <div className="text-xs text-muted-foreground">{t("monitor.empty.votes")}</div>
            )}
          </div>
        );
      })}
    </div>
  );
}
