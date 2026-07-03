import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useScheduleStore } from "@/stores/schedule-store";
import type {
  CreateScheduledTaskRequest,
  ScheduleConfig,
  ScheduledTask,
  UpdateScheduledTaskRequest,
} from "@/types/schedule";
import { text, type ToolContext } from "./tool-context";

const SCHEDULE_PERMISSION_MODES = [
  Type.Literal("readonly"),
  Type.Literal("safe"),
  Type.Literal("ai_review"),
] as const;

const scheduleConfigSchema = Type.Union([
  Type.Object({ kind: Type.Literal("at"), at: Type.String({ description: "ISO-8601 时间" }) }),
  Type.Object({
    kind: Type.Literal("every"),
    everyMs: Type.Number({ description: "间隔毫秒，最小 60000（60秒）", minimum: 60_000 }),
    startAt: Type.Optional(Type.String({ description: "可选起始时间，ISO-8601" })),
  }),
  Type.Object({ kind: Type.Literal("cron"), expr: Type.String({ description: "五段 Cron 表达式，例如 0 * * * *" }) }),
]);

const schedulePayloadSchema = Type.Object({
  message: Type.String({ description: "到时交给 Agent 执行的自然语言指令" }),
  contextDirs: Type.Optional(Type.Array(Type.String(), { description: "可选上下文目录列表" })),
  agentId: Type.Optional(Type.String({ description: "可选 Agent ID，默认 default" })),
  workingDir: Type.Optional(Type.String({ description: "可选工作目录" })),
  permissionMode: Type.Optional(Type.Union([...SCHEDULE_PERMISSION_MODES])),
});

const taskQuerySchema = Type.Object({
  taskId: Type.Optional(Type.String({ description: "定时任务 ID，优先使用" })),
  taskName: Type.Optional(Type.String({ description: "定时任务名称；拿不到 taskId 时可用名称定位" })),
});

const listScheduleTasksParams = Type.Object({
  includeDisabled: Type.Optional(Type.Boolean({ description: "是否包含已禁用任务，默认 true" })),
});

const updateScheduleTaskParams = Type.Intersect([
  taskQuerySchema,
  Type.Object({
    name: Type.Optional(Type.String({ description: "新的任务名称" })),
    description: Type.Optional(Type.String({ description: "新的任务描述" })),
    enabled: Type.Optional(Type.Boolean({ description: "是否启用" })),
    schedule: Type.Optional(scheduleConfigSchema),
    payload: Type.Optional(schedulePayloadSchema),
    missedRunPolicy: Type.Optional(
      Type.Union([
        Type.Literal("prompt"),
        Type.Literal("run_all"),
        Type.Literal("run_latest"),
        Type.Literal("skip"),
      ]),
    ),
    stop_current_run: Type.Optional(Type.Boolean({ description: "若当前任务正在执行，是否同时停止当前这次执行" })),
  }),
]);

const deleteScheduleTaskParams = Type.Intersect([
  taskQuerySchema,
  Type.Object({
    confirm: Type.Boolean({ description: "必须设为 true 以确认删除" }),
    stop_current_run: Type.Optional(Type.Boolean({ description: "若当前任务正在执行，删除前是否先停止当前执行；默认 true" })),
  }),
]);

function resolveTaskOrThrow(query: { taskId?: string; name?: string }): ScheduledTask {
  const task = useScheduleStore.getState().getTaskByIdOrName({
    id: query.taskId,
    name: query.name,
  });

  if (!task) {
    throw new Error(
      query.taskId
        ? `找不到 taskId 为「${query.taskId}」的定时任务。`
        : `找不到名称为「${query.name ?? ""}」的定时任务。`,
    );
  }

  return task;
}

function formatTaskSummary(task: ScheduledTask): Record<string, unknown> {
  return {
    taskId: task.id,
    name: task.name,
    description: task.description,
    enabled: task.enabled,
    schedule: task.schedule,
    payload: task.payload,
    missedRunPolicy: task.missedRunPolicy,
    nextRunAt: task.nextRunAt ?? null,
    lastRunAt: task.lastRunAt ?? null,
    lastRunStatus: task.lastRunStatus ?? null,
    lastError: task.lastError ?? null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function buildUpdateRequest(
  task: ScheduledTask,
  params: Static<typeof updateScheduleTaskParams>,
): UpdateScheduledTaskRequest {
  const request: UpdateScheduledTaskRequest = { id: task.id };

  if (params.name !== undefined) request.name = params.name;
  if (params.description !== undefined) request.description = params.description;
  if (params.enabled !== undefined) request.enabled = params.enabled;
  if (params.schedule !== undefined) request.schedule = params.schedule as ScheduleConfig;
  if (params.missedRunPolicy !== undefined) request.missedRunPolicy = params.missedRunPolicy;

  if (params.payload !== undefined) {
    request.payload = {
      kind: "agentTurn",
      message: params.payload.message,
      contextDirs: params.payload.contextDirs,
      agentId: params.payload.agentId,
      workingDir: params.payload.workingDir,
      permissionMode: params.payload.permissionMode,
    } satisfies CreateScheduledTaskRequest["payload"];
  }

  return request;
}

export function listScheduleTasksTool(_ctx: ToolContext): AgentTool<typeof listScheduleTasksParams> {
  return {
    name: "list_schedule_tasks",
    label: "列出定时任务",
    description: "列出当前所有后台定时任务，返回 taskId、名称、启用状态、下次执行时间等信息，便于后续编辑或删除。",
    parameters: listScheduleTasksParams,
    execute: async (_id, params: Static<typeof listScheduleTasksParams>) => {
      await useScheduleStore.getState().initialize();
      const tasks = useScheduleStore
        .getState()
        .tasks.filter((task) => (params.includeDisabled ?? true ? true : task.enabled));

      const lines = tasks.length === 0
        ? ["当前没有定时任务。"]
        : tasks.map((task, index) => {
            const state = task.enabled ? "启用" : "禁用";
            const nextRun = task.nextRunAt ? new Date(task.nextRunAt).toISOString() : "-";
            return `${index + 1}. ${task.name} | taskId=${task.id} | ${state} | next=${nextRun}`;
          });

      return {
        content: text(lines.join("\n")),
        details: {
          success: true,
          count: tasks.length,
          tasks: tasks.map((task) => formatTaskSummary(task)),
        },
      };
    },
  };
}

export function updateScheduleTaskTool(_ctx: ToolContext): AgentTool<typeof updateScheduleTaskParams> {
  return {
    name: "update_schedule_task",
    label: "编辑定时任务",
    description: "按 taskId 或名称编辑已有定时任务，可修改名称、说明、启用状态、调度方式、执行内容等；需要时也可以停止当前正在执行的这一轮。",
    parameters: updateScheduleTaskParams,
    execute: async (_id, params: Static<typeof updateScheduleTaskParams>) => {
      await useScheduleStore.getState().initialize();
      const task = resolveTaskOrThrow({ taskId: params.taskId, name: params.taskName });

      if (params.stop_current_run) {
        useScheduleStore.getState().stopTaskRun(task.id);
      }

      const updated = await useScheduleStore.getState().updateTask(buildUpdateRequest(task, params));

      return {
        content: text(`定时任务「${updated.name}」已更新。`),
        details: {
          success: true,
          task: formatTaskSummary(updated),
          stoppedCurrentRun: params.stop_current_run === true,
        },
      };
    },
  };
}

export function deleteScheduleTaskTool(_ctx: ToolContext): AgentTool<typeof deleteScheduleTaskParams> {
  return {
    name: "delete_schedule_task",
    label: "删除定时任务",
    description: "按 taskId 或名称删除已有定时任务。删除前必须 confirm=true；如任务正在执行，可同时停止当前运行。",
    parameters: deleteScheduleTaskParams,
    execute: async (_id, params: Static<typeof deleteScheduleTaskParams>) => {
      if (params.confirm !== true) {
        throw new Error("删除定时任务前必须将 confirm 设为 true。");
      }

      await useScheduleStore.getState().initialize();
      const task = resolveTaskOrThrow({ taskId: params.taskId, name: params.taskName });
      const stoppedCurrentRun = (params.stop_current_run ?? true)
        ? useScheduleStore.getState().stopTaskRun(task.id)
        : false;

      await useScheduleStore.getState().deleteTask(task.id);

      return {
        content: text(`定时任务「${task.name}」已删除。`),
        details: {
          success: true,
          taskId: task.id,
          name: task.name,
          stoppedCurrentRun,
        },
      };
    },
  };
}
