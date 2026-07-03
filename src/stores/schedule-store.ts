import { create } from "zustand";

import { computeNextRunAt } from "@/lib/schedule/runtime";
import { scheduleRuntime } from "@/lib/schedule/runtime";
import {
  deleteScheduledTaskConfig,
  loadScheduleLogs,
  loadScheduledTasks,
  saveScheduledTasks,
} from "@/lib/schedule/storage";
import type {
  CreateScheduledTaskRequest,
  ScheduleLogEntry,
  ScheduleStats,
  ScheduleTaskRuntimeState,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@/types/schedule";

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `task-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sortTasks(tasks: ScheduledTask[]): ScheduledTask[] {
  return [...tasks].sort((a, b) => b.updatedAt - a.updatedAt);
}

function computeStats(
  tasks: ScheduledTask[],
  logsByTask: Record<string, ScheduleLogEntry[]>,
  runtimeStates: Record<string, ScheduleTaskRuntimeState>,
): ScheduleStats {
  const allLogs = Object.values(logsByTask).flat();
  return {
    totalTasks: tasks.length,
    enabledTasks: tasks.filter((task) => task.enabled).length,
    runningTasks: Object.values(runtimeStates).filter((state) => state.state === "running").length,
    totalRuns: allLogs.length,
    successRuns: allLogs.filter((log) => log.status === "success").length,
    failedRuns: allLogs.filter((log) => log.status === "failed").length,
  };
}

interface ScheduleStoreState {
  tasks: ScheduledTask[];
  logsByTask: Record<string, ScheduleLogEntry[]>;
  runtimeStates: Record<string, ScheduleTaskRuntimeState>;
  isLoading: boolean;
  initialized: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  loadTasks: () => Promise<void>;
  createTask: (request: CreateScheduledTaskRequest) => Promise<ScheduledTask>;
  updateTask: (request: UpdateScheduledTaskRequest) => Promise<ScheduledTask>;
  deleteTask: (taskId: string) => Promise<void>;
  toggleTask: (taskId: string, enabled: boolean) => Promise<void>;
  runTaskNow: (taskId: string) => Promise<ScheduleLogEntry>;
  loadLogs: (taskId: string) => Promise<ScheduleLogEntry[]>;
  getStats: () => ScheduleStats;
}

let runtimeSubscribed = false;

export const useScheduleStore = create<ScheduleStoreState>((set, get) => ({
  tasks: [],
  logsByTask: {},
  runtimeStates: {},
  isLoading: false,
  initialized: false,
  error: null,

  initialize: async () => {
    if (get().initialized) return;
    set({ isLoading: true, error: null });
    try {
      await scheduleRuntime.initialize();
      if (!runtimeSubscribed) {
        runtimeSubscribed = true;
        scheduleRuntime.subscribe(() => {
          set({
            runtimeStates: scheduleRuntime.getStates(),
            tasks: scheduleRuntime.getTasks(),
          });
        });
      }
      await get().loadTasks();
      set({ initialized: true, runtimeStates: scheduleRuntime.getStates() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    } finally {
      set({ isLoading: false });
    }
  },

  loadTasks: async () => {
    set({ isLoading: true, error: null });
    try {
      const tasks = sortTasks(await loadScheduledTasks());
      const logsEntries = await Promise.all(tasks.map(async (task) => [task.id, await loadScheduleLogs(task.id)] as const));
      const logsByTask = Object.fromEntries(logsEntries);
      scheduleRuntime.syncTasks(tasks);
      set({ tasks, logsByTask, runtimeStates: scheduleRuntime.getStates() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
    } finally {
      set({ isLoading: false });
    }
  },

  createTask: async (request) => {
    const timestamp = Date.now();
    const draft: ScheduledTask = {
      id: createId(),
      name: request.name.trim(),
      description: request.description?.trim() || "",
      enabled: request.enabled ?? true,
      schedule: request.schedule,
      payload: request.payload,
      missedRunPolicy: request.missedRunPolicy ?? "run_latest",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const task: ScheduledTask = {
      ...draft,
      nextRunAt: computeNextRunAt(draft, timestamp),
    };
    const nextTasks = sortTasks([...get().tasks, task]);
    await saveScheduledTasks(nextTasks);
    scheduleRuntime.syncTasks(nextTasks);
    set((state) => ({
      tasks: nextTasks,
      runtimeStates: scheduleRuntime.getStates(),
      logsByTask: {
        ...state.logsByTask,
        [task.id]: state.logsByTask[task.id] || [],
      },
    }));
    return task;
  },

  updateTask: async (request) => {
    const existing = get().tasks.find((task) => task.id === request.id);
    if (!existing) {
      throw new Error(`定时任务不存在: ${request.id}`);
    }
    const merged: ScheduledTask = {
      ...existing,
      ...(request.name !== undefined ? { name: request.name.trim() } : {}),
      ...(request.description !== undefined ? { description: request.description.trim() } : {}),
      ...(request.enabled !== undefined ? { enabled: request.enabled } : {}),
      ...(request.schedule !== undefined ? { schedule: request.schedule } : {}),
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
      ...(request.missedRunPolicy !== undefined ? { missedRunPolicy: request.missedRunPolicy } : {}),
      updatedAt: Date.now(),
    };
    const updated: ScheduledTask = {
      ...merged,
      nextRunAt: computeNextRunAt(merged, Date.now()),
    };
    const nextTasks = sortTasks(get().tasks.map((task) => (task.id === updated.id ? updated : task)));
    await saveScheduledTasks(nextTasks);
    scheduleRuntime.syncTasks(nextTasks);
    set({ tasks: nextTasks, runtimeStates: scheduleRuntime.getStates() });
    return updated;
  },

  deleteTask: async (taskId) => {
    const nextTasks = get().tasks.filter((task) => task.id !== taskId);
    await saveScheduledTasks(nextTasks);
    await deleteScheduledTaskConfig(taskId);
    scheduleRuntime.syncTasks(nextTasks);
    set((state) => {
      const nextLogs = { ...state.logsByTask };
      delete nextLogs[taskId];
      return {
        tasks: nextTasks,
        logsByTask: nextLogs,
        runtimeStates: scheduleRuntime.getStates(),
      };
    });
  },

  toggleTask: async (taskId, enabled) => {
    await get().updateTask({ id: taskId, enabled });
  },

  runTaskNow: async (taskId) => {
    const log = await scheduleRuntime.runTask(taskId, "manual");
    const logs = await get().loadLogs(taskId);
    set({ runtimeStates: scheduleRuntime.getStates(), tasks: scheduleRuntime.getTasks() });
    return logs.find((item) => item.id === log.id) ?? log;
  },

  loadLogs: async (taskId) => {
    const logs = await loadScheduleLogs(taskId);
    set((state) => ({
      logsByTask: {
        ...state.logsByTask,
        [taskId]: logs,
      },
    }));
    return logs;
  },

  getStats: () => computeStats(get().tasks, get().logsByTask, get().runtimeStates),
}));
