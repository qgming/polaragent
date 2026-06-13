// 目标区域组件 - 显示在右侧边栏顶部
// src/components/goal/GoalSection.tsx

import { useEffect, useState, type ReactNode } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Coins,
  Edit,
  Gauge,
  Loader2,
  Pause,
  Play,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { abortAgentThread } from "@/ai/agent";
import { Button } from "@/components/ui/button";
import { useGoalStore } from "@/stores/goal-store";
import { GoalEditModal } from "./GoalEditModal";
import { appendGoalEvent } from "@/lib/session/goal";
import {
  isGoalRunningStatus,
  resumeGoal,
  startGoal,
} from "@/ai/goal-supervisor";
import { useChatStore } from "@/stores/chat-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import type { GoalState, GoalStatus } from "@/lib/goal/types";
import { cn } from "@/lib/utils";

export function GoalSection({
  threadId,
  agentId,
}: {
  threadId: string;
  agentId: string;
}) {
  const goal = useGoalStore((s) => s.getGoal(threadId));
  const clearGoal = useGoalStore((s) => s.clearGoal);
  const setStatus = useGoalStore((s) => s.setStatus);
  const tokenTotal = useChatStore((s) => {
    const thread = s.threads.find((t) => t.id === threadId);
    return (
      thread?.messages.reduce((sum, message) => sum + (message.tokenCount ?? 0), 0) ??
      0
    );
  });
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!goal || goal.completedAt || !goal.startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [goal]);

  if (!goal) {
    return (
      <>
        <div className="px-3 py-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-full gap-1.5 text-xs"
            onClick={() => setIsEditModalOpen(true)}
          >
            <Plus className="size-3.5" />
            创建目标
          </Button>
        </div>

        <GoalEditModal
          isOpen={isEditModalOpen}
          onClose={() => setIsEditModalOpen(false)}
          threadId={threadId}
          initialGoal={undefined}
        />
      </>
    );
  }

  const statusInfo = getStatusInfo(goal.status);
  const isRunning = isGoalRunningStatus(goal.status);
  const canStart = goal.status === "ready";
  const canResume =
    goal.status === "paused" ||
    goal.status === "errored" ||
    goal.status === "needs_user_input" ||
    goal.status === "blocked";
  const canEdit = !isRunning;
  const tokenSpend = Math.max(0, tokenTotal - (goal.tokenBaseline ?? tokenTotal));
  const duration = goalDuration(goal, now);

  const handlePause = () => {
    setStatus(threadId, "paused");
    void appendGoalEvent(threadId, {
      type: "goal_paused",
      status: "paused",
      timestamp: Date.now(),
      error: "用户手动暂停",
    });
    abortAgentThread(threadId);
  };

  const handleStart = () => {
    const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
    const workingDir = useTaskMonitorStore.getState().getMonitor(threadId).workingDir;
    void startGoal(
      threadId,
      agentId,
      workingDir,
      thread?.permissionMode,
      thread?.knowledgeBaseIds,
    );
  };

  const handleResume = () => {
    const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
    const workingDir = useTaskMonitorStore.getState().getMonitor(threadId).workingDir;
    void resumeGoal(
      threadId,
      agentId,
      workingDir,
      thread?.permissionMode,
      thread?.knowledgeBaseIds,
    );
  };

  const handleRemove = () => {
    void appendGoalEvent(threadId, {
      type: "goal_cleared",
      status: goal.status,
      timestamp: Date.now(),
      error: "用户清除目标",
    });
    clearGoal(threadId);
  };

  return (
    <>
      <div className="space-y-3 px-3 py-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-1.5">
              <span
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md px-2 text-[11px] font-medium",
                  statusInfo.className,
                )}
              >
                {statusInfo.icon}
                {statusInfo.label}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {goal.evaluatedTurnCount}/{goal.maxTurns ?? "-"} 轮
              </span>
            </div>
            <p className="line-clamp-4 text-sm leading-relaxed text-foreground">
              {goal.goalText}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            {isRunning ? (
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={handlePause}
                title="暂停目标"
              >
                <Pause className="size-3.5" />
              </Button>
            ) : canResume ? (
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={handleResume}
                title="恢复目标"
              >
                <Play className="size-3.5" />
              </Button>
            ) : canStart ? (
              <Button
                variant="outline"
                size="icon"
                className="size-7"
                onClick={handleStart}
                title="启动目标"
              >
                <Play className="size-3.5" />
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="icon"
              className="size-7"
              onClick={() => setIsEditModalOpen(true)}
              disabled={!canEdit}
              title="编辑目标"
            >
              <Edit className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={handleRemove}
              disabled={isRunning}
              title="移除目标"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        </div>

        {(goal.successCriteria || goal.constraints) && (
          <div className="space-y-2 rounded-md bg-muted/45 px-3 py-2 text-xs leading-relaxed">
            {goal.successCriteria ? (
              <div>
                <span className="font-medium text-foreground">验收：</span>
                <span className="text-muted-foreground">{goal.successCriteria}</span>
              </div>
            ) : null}
            {goal.constraints ? (
              <div>
                <span className="font-medium text-foreground">约束：</span>
                <span className="text-muted-foreground">{goal.constraints}</span>
              </div>
            ) : null}
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
          <Metric
            icon={<Clock className="size-3.5" />}
            label={formatDuration(duration)}
          />
          <Metric
            icon={<Coins className="size-3.5" />}
            label={`${formatTokens(tokenSpend)}${goal.maxTokens ? `/${formatTokens(goal.maxTokens)}` : ""}`}
          />
          <Metric
            icon={<Gauge className="size-3.5" />}
            label={`${goal.autoContinueCount} 次续跑`}
          />
        </div>

        <GoalEvaluationDetails goal={goal} />
      </div>

      <GoalEditModal
        isOpen={isEditModalOpen}
        onClose={() => setIsEditModalOpen(false)}
        threadId={threadId}
        initialGoal={goal}
      />
    </>
  );
}

function Metric({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1 rounded-md bg-muted/35 px-2 py-1.5">
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function GoalEvaluationDetails({ goal }: { goal: GoalState }) {
  const evaluation = goal.lastEvaluation;
  if (!evaluation && !goal.lastError) return null;

  return (
    <div className="space-y-2 rounded-md border border-border/70 px-3 py-2 text-xs leading-relaxed">
      {evaluation?.progressSummary ? (
        <p className="text-foreground">{evaluation.progressSummary}</p>
      ) : null}

      {evaluation?.missingItems.length ? (
        <div>
          <div className="mb-1 font-medium text-muted-foreground">未完成</div>
          <ul className="space-y-1 text-muted-foreground">
            {evaluation.missingItems.slice(0, 4).map((item) => (
              <li key={item} className="line-clamp-2">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {evaluation?.evidence.length ? (
        <div>
          <div className="mb-1 font-medium text-muted-foreground">证据</div>
          <ul className="space-y-1 text-muted-foreground">
            {evaluation.evidence.slice(0, 4).map((item) => (
              <li key={item} className="line-clamp-2">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {goal.lastError ? (
        <div className="text-destructive">{goal.lastError}</div>
      ) : null}
    </div>
  );
}

function getStatusInfo(status: GoalStatus) {
  switch (status) {
    case "ready":
      return {
        label: "就绪",
        className: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
        icon: <Pause className="size-3" />,
      };
    case "running":
      return {
        label: "执行中",
        className: "bg-green-500/10 text-green-600 dark:text-green-400",
        icon: <Loader2 className="size-3 animate-spin" />,
      };
    case "evaluating":
      return {
        label: "评估中",
        className: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
        icon: <Loader2 className="size-3 animate-spin" />,
      };
    case "continuing":
      return {
        label: "续跑中",
        className: "bg-green-500/10 text-green-600 dark:text-green-400",
        icon: <Loader2 className="size-3 animate-spin" />,
      };
    case "completed":
      return {
        label: "已完成",
        className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        icon: <CheckCircle2 className="size-3" />,
      };
    case "paused":
      return {
        label: "已暂停",
        className: "bg-orange-500/10 text-orange-600 dark:text-orange-400",
        icon: <Pause className="size-3" />,
      };
    case "needs_user_input":
      return {
        label: "等输入",
        className: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400",
        icon: <AlertCircle className="size-3" />,
      };
    case "blocked":
      return {
        label: "已阻塞",
        className: "bg-red-500/10 text-red-600 dark:text-red-400",
        icon: <ShieldAlert className="size-3" />,
      };
    case "budget_exhausted":
      return {
        label: "预算耗尽",
        className: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
        icon: <Gauge className="size-3" />,
      };
    case "errored":
      return {
        label: "出错",
        className: "bg-red-500/10 text-red-600 dark:text-red-400",
        icon: <AlertCircle className="size-3" />,
      };
  }
}

function goalDuration(goal: GoalState, now: number): number {
  const start = goal.startedAt ?? goal.createdAt;
  const end = goal.completedAt ?? now;
  return Math.max(0, end - start);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

function formatTokens(count: number): string {
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}
