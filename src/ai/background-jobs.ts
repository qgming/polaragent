import type { AgentMessage, AgentHarness } from "@earendil-works/pi-agent-core";

import type { ToolContext } from "./tools/tool-context";

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJobEvent {
  timestamp: string;
  message: string;
}

export interface BackgroundJob {
  id: string;
  name: string;
  task: string;
  agentId: string;
  parentThreadId: string;
  sessionId: string;
  status: BackgroundJobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  events: BackgroundJobEvent[];
}

const jobs = new Map<string, BackgroundJob & { harness?: AgentHarness }>();

export interface StartBackgroundJobParams {
  name?: string;
  task: string;
  context?: string;
  agentId?: string;
}

export function startBackgroundJob(
  ctx: ToolContext,
  params: StartBackgroundJobParams,
): BackgroundJob {
  const id = makeJobId();
  const parentThreadId = ctx.parentThreadId ?? ctx.threadId;
  const agentId = params.agentId?.trim() || ctx.requester?.id || "default";
  const job: BackgroundJob & { harness?: AgentHarness } = {
    id,
    name: params.name?.trim() || `后台任务 ${id}`,
    task: params.task.trim(),
    agentId,
    parentThreadId,
    sessionId: `${parentThreadId}__bg_${id}`,
    status: "running",
    createdAt: new Date().toISOString(),
    events: [],
  };
  jobs.set(id, job);
  void runBackgroundJob(job, ctx, params);
  return serializeJob(job);
}

export function listBackgroundJobs(includeFinished = true): BackgroundJob[] {
  return Array.from(jobs.values())
    .filter((job) => includeFinished || job.status === "running")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((job) => serializeJob(job));
}

export function getBackgroundJob(id: string): BackgroundJob | undefined {
  const job = jobs.get(id);
  return job ? serializeJob(job) : undefined;
}

export function cancelBackgroundJob(id: string): BackgroundJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === "running") {
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    job.events.push({ timestamp: job.completedAt, message: "已请求取消后台任务。" });
    job.harness?.abort();
  }
  return serializeJob(job);
}

async function runBackgroundJob(
  job: BackgroundJob & { harness?: AgentHarness },
  ctx: ToolContext,
  params: StartBackgroundJobParams,
): Promise<void> {
  job.startedAt = new Date().toISOString();
  job.events.push({ timestamp: job.startedAt, message: "后台任务已启动。" });
  try {
    const { agentManager } = await import("./agent-manager");
    const harness = await agentManager.getOrCreateHarness(job.parentThreadId, job.agentId, {
      workingDir: ctx.workingDir,
      permissionMode: ctx.permissionMode,
      knowledgeBaseIds: ctx.knowledgeBaseIds,
      projectId: ctx.projectId,
      scheduleContext: {
        isSchedule: true,
        sessionId: job.sessionId,
      },
    });
    job.harness = harness;
    const unsubscribe = harness.subscribe((event) => {
      if (job.status !== "running") return;
      if (event.type === "tool_execution_start") {
        job.events.push({
          timestamp: new Date().toISOString(),
          message: `开始执行工具：${event.toolName}`,
        });
      } else if (event.type === "tool_execution_update") {
        const summary = extractSummary(event.partialResult);
        if (summary) {
          job.events.push({
            timestamp: new Date().toISOString(),
            message: summary,
          });
        }
      } else if (event.type === "tool_execution_end") {
        job.events.push({
          timestamp: new Date().toISOString(),
          message: `${event.isError ? "工具失败" : "工具完成"}：${event.toolName}`,
        });
      }
    });

    try {
      const response = await harness.prompt(buildBackgroundPrompt(job, params.context));
      await harness.waitForIdle();
      if (job.status === "cancelled") return;
      job.status = "completed";
      job.completedAt = new Date().toISOString();
      job.result = assistantMessageText(response) || "后台任务已完成，但没有返回可提取的文本内容。";
      job.events.push({ timestamp: job.completedAt, message: "后台任务已完成。" });
    } finally {
      unsubscribe();
    }
  } catch (error) {
    if (job.status === "cancelled") return;
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.error = error instanceof Error ? error.message : String(error);
    job.events.push({
      timestamp: job.completedAt,
      message: `后台任务失败：${job.error}`,
    });
  }
}

function buildBackgroundPrompt(job: BackgroundJob, context?: string): string {
  const parts = [
    "请作为后台任务执行以下指令。不要询问用户；如果信息不足，请基于现有上下文产出最有用的结果，并明确说明假设和限制。",
    `任务名称：${job.name}`,
    `任务内容：${job.task}`,
  ];
  if (context?.trim()) {
    parts.push("补充上下文：", context.trim());
  }
  parts.push("请在完成后给出简洁但完整的结果摘要、已执行动作、产物路径和后续建议。");
  return parts.join("\n\n");
}

function extractSummary(partial: unknown): string | undefined {
  if (!partial || typeof partial !== "object") return undefined;
  const details = (partial as { details?: Record<string, unknown> }).details;
  if (typeof details?.summary === "string" && details.summary.trim()) {
    return details.summary.trim();
  }
  const content = (partial as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const first = content.find(
      (item): item is { text: string } =>
        item != null && typeof item === "object" && typeof (item as { text?: unknown }).text === "string",
    );
    return first?.text;
  }
  return undefined;
}

function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const maybeMessage = message as Partial<AgentMessage>;
  if (maybeMessage.role !== "assistant" || !Array.isArray(maybeMessage.content)) {
    return "";
  }
  return maybeMessage.content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      if ("text" in block && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function serializeJob(job: BackgroundJob & { harness?: AgentHarness }): BackgroundJob {
  const { harness: _harness, ...rest } = job;
  return {
    ...rest,
    events: rest.events.slice(-50),
  };
}

function makeJobId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
