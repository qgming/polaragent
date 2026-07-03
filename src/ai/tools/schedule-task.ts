import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { useScheduleStore } from "@/stores/schedule-store";
import { text, type ToolContext } from "./tool-context";

// 工具 schema 说明：AI 创建定时任务时可选的 permissionMode 字面量。
// 刻意不包含 "full" —— 后台无人监督的任务绝不能以完全权限运行，否则
// 构成"AI 自选升权 + 持久化无人监督执行"的提权链路。即便 AI 强行
// 透传 full，runtime 层会再次钳到 ai_review（见 runtime.ts 的 sanitize）。
const SCHEDULE_PERMISSION_MODES = [
  Type.Literal("readonly"),
  Type.Literal("safe"),
  Type.Literal("ai_review"),
] as const;

const scheduleTaskParams = Type.Object({
  name: Type.String({ description: "任务名称" }),
  description: Type.Optional(Type.String({ description: "任务描述" })),
  enabled: Type.Optional(Type.Boolean({ description: "是否启用，默认 true" })),
  schedule: Type.Union([
    Type.Object({ kind: Type.Literal("at"), at: Type.String({ description: "ISO-8601 时间" }) }),
    // everyMs 设最小 60 秒，避免毫秒级风暴触发 AI/磁盘 DoS
    Type.Object({
      kind: Type.Literal("every"),
      everyMs: Type.Number({ description: "间隔毫秒，最小 60000（60秒）", minimum: 60_000 }),
      startAt: Type.Optional(Type.String({ description: "可选起始时间，ISO-8601" })),
    }),
    Type.Object({ kind: Type.Literal("cron"), expr: Type.String({ description: "五段 Cron 表达式，例如 0 * * * *" }) }),
  ]),
  payload: Type.Object({
    message: Type.String({ description: "到时交给 Agent 执行的自然语言指令" }),
    contextDirs: Type.Optional(Type.Array(Type.String(), { description: "可选上下文目录列表" })),
    agentId: Type.Optional(Type.String({ description: "可选 Agent ID，默认 default" })),
    workingDir: Type.Optional(Type.String({ description: "可选工作目录" })),
    permissionMode: Type.Optional(Type.Union([...SCHEDULE_PERMISSION_MODES])),
  }),
  missedRunPolicy: Type.Optional(
    Type.Union([
      Type.Literal("prompt"),
      Type.Literal("run_all"),
      Type.Literal("run_latest"),
      Type.Literal("skip"),
    ]),
  ),
  run_now: Type.Optional(Type.Boolean({ description: "创建后是否立即执行一次" })),
});

export function scheduleTaskTool(_ctx: ToolContext): AgentTool<typeof scheduleTaskParams> {
  return {
    name: "schedule_task",
    label: "创建定时任务",
    description:
      "创建一个后台定时任务，让 Agent 在指定时间自动执行指令。支持 at / every / cron 三种调度方式，" +
      "可选立即执行一次。",
    parameters: scheduleTaskParams,
    execute: async (_id, params: Static<typeof scheduleTaskParams>) => {
      await useScheduleStore.getState().initialize();
      const task = await useScheduleStore.getState().createTask({
        name: params.name,
        description: params.description,
        enabled: params.enabled,
        schedule: params.schedule,
        payload: {
          kind: "agentTurn",
          message: params.payload.message,
          contextDirs: params.payload.contextDirs,
          agentId: params.payload.agentId,
          workingDir: params.payload.workingDir,
          permissionMode: params.payload.permissionMode,
        },
        missedRunPolicy: params.missedRunPolicy,
      });

      let followUp = "";
      if (params.run_now) {
        await useScheduleStore.getState().runTaskNow(task.id);
        followUp = " 并已立即执行一次。";
      }

      return {
        content: text(`定时任务「${task.name}」已创建。${followUp}`),
        details: {
          success: true,
          taskId: task.id,
          name: task.name,
          enabled: task.enabled,
          nextRunAt: task.nextRunAt,
          schedule: task.schedule,
          followUp: followUp.trim() || null,
        },
      };
    },
  };
}
