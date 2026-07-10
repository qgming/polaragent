import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import {
  cancelBackgroundJob,
  getBackgroundJob,
  listBackgroundJobs,
  startBackgroundJob,
} from "@/ai/background-jobs";
import { text, type ToolContext } from "./tool-context";

const startBackgroundTaskParams = Type.Object({
  task: Type.String({
    description: "要放到后台执行的明确任务。应包含目标、范围和期望输出。",
    minLength: 1,
  }),
  name: Type.Optional(Type.String({ description: "后台任务名称，便于后续查询。" })),
  context: Type.Optional(Type.String({ description: "补充上下文、约束、当前进展或相关路径。" })),
  agentId: Type.Optional(Type.String({ description: "可选目标助手 ID；默认使用当前助手。" })),
});

const listBackgroundTasksParams = Type.Object({
  includeFinished: Type.Optional(Type.Boolean({ description: "是否包含已完成/失败/取消的任务，默认 true。" })),
});

const backgroundTaskQueryParams = Type.Object({
  jobId: Type.String({ description: "后台任务 ID。" }),
});

export function startBackgroundTaskTool(
  ctx: ToolContext,
): AgentTool<typeof startBackgroundTaskParams> {
  return {
    name: "start_background_task",
    label: "启动后台任务",
    description:
      "把耗时较长、可异步完成的任务放到独立后台 Agent 会话执行，并立即返回 jobId。主对话可继续回复、调用其他工具，之后用 get_background_task 查询结果。",
    parameters: startBackgroundTaskParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof startBackgroundTaskParams>) => {
      const job = startBackgroundJob(ctx, params);
      return {
        content: text(
          `后台任务「${job.name}」已启动，jobId=${job.id}。可稍后调用 get_background_task 查询结果，或调用 cancel_background_task 取消。`,
        ),
        details: {
          job,
          jobId: job.id,
          status: job.status,
        },
      };
    },
  };
}

export function listBackgroundTasksTool(): AgentTool<typeof listBackgroundTasksParams> {
  return {
    name: "list_background_tasks",
    label: "列出后台任务",
    description: "列出当前应用内后台 Agent 任务，包含 jobId、名称、状态、创建时间和完成时间。",
    parameters: listBackgroundTasksParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof listBackgroundTasksParams>) => {
      const jobs = listBackgroundJobs(params.includeFinished ?? true);
      const lines =
        jobs.length === 0
          ? ["当前没有后台任务。"]
          : jobs.map((job, index) => {
              const finished = job.completedAt ? ` | completed=${job.completedAt}` : "";
              return `${index + 1}. ${job.name} | jobId=${job.id} | ${job.status}${finished}`;
            });
      return {
        content: text(lines.join("\n")),
        details: {
          count: jobs.length,
          jobs,
        },
      };
    },
  };
}

export function getBackgroundTaskTool(): AgentTool<typeof backgroundTaskQueryParams> {
  return {
    name: "get_background_task",
    label: "查看后台任务",
    description: "查看后台任务状态、执行过程、错误或最终结果。",
    parameters: backgroundTaskQueryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof backgroundTaskQueryParams>) => {
      const job = getBackgroundJob(params.jobId);
      if (!job) {
        throw new Error(`找不到后台任务：${params.jobId}`);
      }
      const lines = [
        `后台任务「${job.name}」状态：${job.status}`,
        job.result ? `\n结果：\n${job.result}` : "",
        job.error ? `\n错误：${job.error}` : "",
        job.events.length > 0
          ? `\n最近事件：\n${job.events.map((event) => `- ${event.timestamp} ${event.message}`).join("\n")}`
          : "",
      ].filter(Boolean);
      return {
        content: text(lines.join("\n")),
        details: {
          job,
          jobId: job.id,
          status: job.status,
        },
      };
    },
  };
}

export function cancelBackgroundTaskTool(): AgentTool<typeof backgroundTaskQueryParams> {
  return {
    name: "cancel_background_task",
    label: "取消后台任务",
    description: "取消仍在运行的后台 Agent 任务。",
    parameters: backgroundTaskQueryParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof backgroundTaskQueryParams>) => {
      const job = cancelBackgroundJob(params.jobId);
      if (!job) {
        throw new Error(`找不到后台任务：${params.jobId}`);
      }
      return {
        content: text(`后台任务「${job.name}」当前状态：${job.status}。`),
        details: {
          job,
          jobId: job.id,
          status: job.status,
        },
      };
    },
  };
}
