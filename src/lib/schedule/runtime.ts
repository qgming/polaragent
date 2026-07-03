import { promptAgent } from "@/ai/agent";
import { agentManager } from "@/ai/agent-manager";
import { initializeAiRuntime } from "@/lib/app-init";
import {
  buildScheduledAgentMessage,
  resolveScheduledWorkingDir,
} from "@/lib/schedule/prompt";
import {
  appendScheduleLog,
  createScheduleRunDir,
  loadScheduleLogs,
  loadScheduledTasks,
  saveScheduledTasks,
} from "@/lib/schedule/storage";
import {
  createScheduleRunId,
  createScheduleThreadId,
} from "@/lib/schedule/runtime-ids";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import type {
  ScheduleLogEntry,
  ScheduleTaskRuntimeState,
  ScheduledTask,
} from "@/types/schedule";
import { nextCronOccurrence, validateCronConfig } from "./cron";

type RuntimeListener = () => void;

const listeners = new Set<RuntimeListener>();

function emitRuntimeChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `schedule-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function now(): number {
  return Date.now();
}

// 调度任务执行权限的硬上限。
// 后台调度任务是无人监督的，绝对不允许以 full 权限运行 —— 那等于把
// "持久化 + 自动触发 + 用户不在场 + 完全权限"四个条件同时满足，构成
// 完整的提权链路。任何尝试通过磁盘任务文件、工具参数或 store 写入
// permissionMode:"full" 的，runtime 层都会在这里强制钳到 ai_review。
// 仅允许 readonly/safe/ai_review 三档；非法值回退到默认档。
type ScheduleSafePermissionMode = "readonly" | "safe" | "ai_review";

const SCHEDULE_MAX_PERMISSION_MODE: ScheduleSafePermissionMode = "ai_review";

function sanitizeScheduledPermissionMode(
  mode: string | undefined,
): ScheduleSafePermissionMode {
  if (mode === "readonly" || mode === "safe" || mode === "ai_review") {
    return mode;
  }
  // full 或任何非法值 → 强制回退到 ai_review（不能用 full）
  if (mode === "full") {
    console.warn(
      `[schedule] 后台调度任务检测到非法 permissionMode="full"，已降级到 ai_review。` +
        `后台任务绝不可以完全权限执行。`,
    );
  }
  return SCHEDULE_MAX_PERMISSION_MODE;
}

function nextEveryOccurrence(everyMs: number, anchorMs: number, fromMs: number): number {
  if (everyMs <= 0) throw new Error("everyMs 必须大于 0");
  if (fromMs < anchorMs) return anchorMs;
  const elapsed = fromMs - anchorMs;
  const intervals = Math.floor(elapsed / everyMs) + 1;
  return anchorMs + intervals * everyMs;
}

export function computeNextRunAt(task: ScheduledTask, fromMs = now()): number | undefined {
  if (!task.enabled) return undefined;

  if (task.schedule.kind === "at") {
    const target = Date.parse(task.schedule.at);
    if (!Number.isFinite(target)) throw new Error(`无效的一次性执行时间: ${task.schedule.at}`);
    return target > fromMs ? target : undefined;
  }

  if (task.schedule.kind === "every") {
    const anchorMs = task.schedule.startAt
      ? Date.parse(task.schedule.startAt)
      : task.createdAt;
    if (!Number.isFinite(anchorMs)) {
      throw new Error("every 任务的 startAt 无效");
    }
    return nextEveryOccurrence(task.schedule.everyMs, anchorMs, fromMs);
  }

  validateCronConfig(task.schedule);
  return nextCronOccurrence(task.schedule.expr, fromMs);
}

function shouldRecoverImmediately(task: ScheduledTask, fromMs = now()): boolean {
  if (!task.enabled || !task.nextRunAt) return false;
  if (task.nextRunAt > fromMs) return false;
  return task.missedRunPolicy === "run_latest" || task.missedRunPolicy === "run_all";
}

class ScheduleRuntime {
  private started = false;

  private tasks = new Map<string, ScheduledTask>();

  private timers = new Map<string, number>();

  private runningTasks = new Set<string>();

  private states = new Map<string, ScheduleTaskRuntimeState>();

  async initialize(): Promise<void> {
    if (this.started) return;
    this.started = true;
    initializeAiRuntime();
    const tasks = await loadScheduledTasks();
    this.replaceTasks(tasks);
    await this.recoverMissedTasks();
  }

  subscribe(listener: RuntimeListener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  getTasks(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getStates(): Record<string, ScheduleTaskRuntimeState> {
    return Object.fromEntries(this.states.entries());
  }

  async refresh(): Promise<void> {
    const tasks = await loadScheduledTasks();
    this.replaceTasks(tasks);
  }

  syncTasks(tasks: ScheduledTask[]): void {
    this.replaceTasks(tasks);
  }

  private replaceTasks(tasks: ScheduledTask[]): void {
    const incoming = new Map(tasks.map((task) => [task.id, task]));
    for (const taskId of this.tasks.keys()) {
      if (!incoming.has(taskId)) {
        this.clearTimer(taskId);
        this.tasks.delete(taskId);
        this.states.delete(taskId);
      }
    }

    for (const task of tasks) {
      this.tasks.set(task.id, task);
      this.scheduleTask(task);
    }
    emitRuntimeChange();
  }

  private clearTimer(taskId: string): void {
    const timer = this.timers.get(taskId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.timers.delete(taskId);
    }
  }

  private scheduleTask(task: ScheduledTask): void {
    this.clearTimer(task.id);

    let nextRunAt: number | undefined;
    try {
      nextRunAt = computeNextRunAt(task, now());
    } catch (error) {
      console.error(`计算定时任务下次执行时间失败 ${task.id}:`, error);
      this.states.set(task.id, {
        taskId: task.id,
        state: "paused",
        lastRunAt: task.lastRunAt,
        lastMessage: error instanceof Error ? error.message : String(error),
      });
      emitRuntimeChange();
      return;
    }

    this.states.set(task.id, {
      taskId: task.id,
      state: this.runningTasks.has(task.id) ? "running" : task.enabled ? "idle" : "paused",
      lastRunAt: task.lastRunAt,
      nextRunAt,
    });

    if (!task.enabled || nextRunAt === undefined) {
      emitRuntimeChange();
      return;
    }

    const delay = Math.max(250, nextRunAt - now());
    const timer = window.setTimeout(() => {
      void this.runTask(task.id, "schedule");
    }, delay);
    this.timers.set(task.id, timer);
    emitRuntimeChange();
  }

  private async recoverMissedTasks(): Promise<void> {
    const recoverable = [...this.tasks.values()].filter((task) => shouldRecoverImmediately(task));
    for (const task of recoverable) {
      await this.runTask(task.id, "recovery");
    }
  }

  async runTask(taskId: string, trigger: "schedule" | "manual" | "recovery"): Promise<ScheduleLogEntry> {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`定时任务不存在: ${taskId}`);

    if (this.runningTasks.has(taskId)) {
      const skipped: ScheduleLogEntry = {
        id: createId(),
        taskId,
        runId: createScheduleRunId(),
        runAt: now(),
        status: "skipped",
        error: "任务正在执行，已跳过本次触发",
        duration: 0,
        workingDir: task.payload.workingDir,
        triggeredBy: trigger,
      };
      await appendScheduleLog(skipped);
      return skipped;
    }

    const startedAt = now();
    const runId = createScheduleRunId(new Date(startedAt));
    const threadId = createScheduleThreadId(taskId, runId);
    const runDir = await createScheduleRunDir(taskId, runId);
    const scheduledWorkingDir = resolveScheduledWorkingDir(task.payload, runDir);

    this.runningTasks.add(taskId);
    this.states.set(taskId, {
      taskId,
      state: "running",
      lastRunAt: task.lastRunAt,
      nextRunAt: task.nextRunAt,
      currentRunId: runId,
      lastMessage: "执行中",
    });
    emitRuntimeChange();

    let output = "";
    let errorMessage: string | undefined;

    try {
      const agentMessage = buildScheduledAgentMessage(task.payload);

      await new Promise<void>((resolve) => {
        void promptAgent(
          agentMessage,
          {
            onStreamUpdate: () => undefined,
            onDone: (result) => {
              output = result.content;
              resolve();
            },
            onError: (message) => {
              errorMessage = message;
              resolve();
            },
          },
          task.payload.agentId || "default",
          {
            threadId,
            workingDir: scheduledWorkingDir,
            // 安全说明：task.payload.permissionMode 不可信（可能来自 AI 自选
            // 或被注入的磁盘任务文件），必须经过 sanitize 强制钳到安全档，
            // 任何 "full" 一律降级到 ai_review —— 后台任务绝不可以完全权限运行。
            permissionMode: sanitizeScheduledPermissionMode(task.payload.permissionMode),
            scheduleContext: {
              isSchedule: true,
              sessionId: threadId,
            },
          },
        );
      });
    } finally {
      try {
        agentManager.disposeThread(threadId);
      } catch (cleanupError) {
        console.warn(`清理定时任务内部会话失败 ${threadId}:`, cleanupError);
      }
      useTaskMonitorStore.getState().clearThread(threadId);
    }

    const finishedAt = now();
    const status = errorMessage ? "failed" : "success";
    const log: ScheduleLogEntry = {
      id: createId(),
      taskId,
      runId,
      runAt: startedAt,
      status,
      output: output || undefined,
      error: errorMessage,
      duration: finishedAt - startedAt,
      threadId,
      workingDir: task.payload.workingDir || scheduledWorkingDir,
      runDir,
      triggeredBy: trigger,
    };

    const taskLogs = await appendScheduleLog(log);
    const nextRunAt = computeNextRunAt(task, finishedAt);
    const updatedTask: ScheduledTask = {
      ...task,
      lastRunAt: finishedAt,
      nextRunAt,
      lastRunStatus: status,
      lastError: errorMessage,
      updatedAt: finishedAt,
    };
    this.tasks.set(taskId, updatedTask);
    await saveScheduledTasks([...this.tasks.values()]);

    this.runningTasks.delete(taskId);
    this.states.set(taskId, {
      taskId,
      state: updatedTask.enabled ? "idle" : "paused",
      lastRunAt: finishedAt,
      nextRunAt,
      lastMessage: errorMessage || `最近日志 ${taskLogs[0]?.status ?? status}`,
    });
    this.scheduleTask(updatedTask);
    emitRuntimeChange();
    return log;
  }

  async getLogs(taskId: string): Promise<ScheduleLogEntry[]> {
    return loadScheduleLogs(taskId);
  }
}

export const scheduleRuntime = new ScheduleRuntime();
