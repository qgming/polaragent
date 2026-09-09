// delegate_task —— 调用临时子代理处理明确子任务
// src/ai/tools/delegate-task.ts

import { Type, type Static } from "typebox";
import {
  BACKGROUND_CONTEXT,
  type AgentHarnessTool,
  type AgentLane,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";

import { text, type ToolContext } from "./tool-context";
import { throwIfAborted } from "./tool-progress";

const delegateTaskParams = Type.Object({
  task: Type.String({
    description: "交给子代理完成的清晰任务。应包含目标、范围、期望输出。",
    minLength: 1,
  }),
  temporaryAgentName: Type.Optional(
    Type.String({
      description: "临时子代理名称。例如“代码审查专家”“资料调研员”。",
    }),
  ),
  temporarySystemPrompt: Type.Optional(
    Type.String({
      description: "临时子代理的角色、能力边界、工作方式和输出要求。",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "补充给子代理的上下文、约束、用户原始需求或当前进展。",
    }),
  ),
});

export function delegateTaskTool(): AgentHarnessTool<ToolContext, typeof delegateTaskParams> {
  return {
    name: "delegate_task",
    label: "调用子代理",
    description:
      "在普通对话中调用一个子代理处理明确子任务。可通过 temporaryAgentName 和 temporarySystemPrompt 创建临时子代理。适合调研、代码审查、方案对比、测试验证、文案润色、专业判断等可并行或需要第二视角的工作。子代理完成后返回结果，最终回复仍由当前助手整合。",
    parameters: delegateTaskParams,
    executionMode: "parallel",
    execute: async (_id, params: Static<typeof delegateTaskParams>, onUpdate, toolContext, _invocation, context) => {
      const ctx = toolContext;
      const signal = context.abortSignal;
      throwIfAborted(signal);
      if (ctx.isSubagent) {
        return {
          content: text("当前已经在子代理中，不能再次调用子代理。请直接完成当前任务并返回结果。"),
          details: { error: "recursive_delegation_blocked" },
        };
      }

      const temporarySystemPrompt = params.temporarySystemPrompt?.trim();
      const temporaryName = params.temporaryAgentName?.trim() || "临时子代理";

      if (!temporarySystemPrompt) {
        return {
          content: text("请提供 temporarySystemPrompt 描述子代理的角色与工作方式，以创建临时子代理。"),
          details: { error: "missing_temporary_system_prompt" },
        };
      }

      const parentThreadId = ctx.parentThreadId ?? ctx.threadId;
      const target = {
        name: temporaryName,
        kind: "temporary" as const,
        systemPrompt: temporarySystemPrompt,
      };
      const childSessionId = makeChildSessionId(parentThreadId, `${target.kind}_${target.name}`);
      const prompt = buildSubagentPrompt({
        task: params.task,
        context: params.context,
        parentThreadId,
      });

      try {
        throwIfAborted(signal);
        onUpdate?.({
          content: text(`正在调用子代理 ${target.name}...`),
          details: {
            agentName: target.name,
            agentKind: target.kind,
            phase: "starting",
          },
        });

        const { agentManager } = await import("@/ai/agent-manager");
        throwIfAborted(signal);
        const harness = await agentManager.getOrCreateHarness(parentThreadId, {
          workingDir: ctx.workingDir,
          permissionMode: ctx.permissionMode,
          knowledgeBaseIds: ctx.knowledgeBaseIds,
          projectId: ctx.projectId,
          subagentContext: {
            isSubagent: true,
            parentThreadId,
            sessionId: childSessionId,
            task: params.task,
            agentName: target.name,
            systemPrompt: target.systemPrompt,
          },
        });
        // 0.85.0: abort 位于 AgentLane，需先取 lane
        const lane = await harness.lane("main", BACKGROUND_CONTEXT);
        const abortSubagent = () => {
          void lane.abort(BACKGROUND_CONTEXT).catch(() => undefined);
        };
        signal?.addEventListener("abort", abortSubagent, { once: true });

        try {
          throwIfAborted(signal);
          onUpdate?.({
            content: text(`子代理 ${target.name} 正在执行任务...`),
            details: {
              agentName: target.name,
              agentKind: target.kind,
              childSessionId,
              phase: "running",
            },
          });

          // 0.85.0: prompt/waitForIdle 位于 AgentLane，需传 context
          await lane.prompt(prompt, undefined, BACKGROUND_CONTEXT);
          await lane.waitForIdle(BACKGROUND_CONTEXT);
          throwIfAborted(signal);
          // 0.85.0: RunResult 不再携带 finalMessage，从 lane 会话转写中取最后一条 assistant 消息
          const resultText =
            (await extractFinalAssistantMessage(lane)) || "子代理已完成，但没有返回可提取的文本内容。";
          const content = [
            `子代理 ${target.name} 已完成任务。`,
            "",
            resultText,
          ].join("\n");

          return {
            content: text(content),
            details: {
              agentName: target.name,
              agentKind: target.kind,
              childSessionId,
              result: resultText,
            },
          };
        } finally {
          signal?.removeEventListener("abort", abortSubagent);
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error instanceof Error ? error : new Error("工具执行已取消");
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: text(`子代理 ${target.name} 执行失败：${message}`),
          details: {
            error: "subagent_failed",
            agentName: target.name,
            agentKind: target.kind,
            childSessionId,
            message,
          },
        };
      }
    },
  };
}

function makeChildSessionId(parentThreadId: string, agentKey: string): string {
  const safeKey = agentKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "agent";
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${parentThreadId}__sub_${safeKey}_${Date.now()}_${entropy}`;
}

function buildSubagentPrompt({
  task,
  context,
  parentThreadId,
  requesterName,
}: {
  task: string;
  context?: string;
  parentThreadId: string;
  requesterName?: string;
}): string {
  const parts = [
    `主助手${requesterName ? `（${requesterName}）` : ""}请求你作为子代理完成以下任务：`,
    task.trim(),
    `父会话 ID：${parentThreadId}`,
  ];
  if (context?.trim()) {
    parts.push("补充上下文：", context.trim());
  }
  parts.push(
    "请直接产出可被主助手整合的结果：关键发现、依据、建议、已完成动作、风险或后续步骤。不要询问用户，除非任务本身无法在现有信息下推进。",
  );
  return parts.join("\n\n");
}

// 0.85.0: RunResult 不再携带 finalMessage，从 lane 的会话转写中反向查找最后一条 assistant 消息，
// 提取其文本内容作为子代理结果摘要。
async function extractFinalAssistantMessage(lane: AgentLane): Promise<string> {
  try {
    const entries = await lane.findEntries({ order: "newestFirst" }, BACKGROUND_CONTEXT);
    for (const entry of entries) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        return assistantMessageText(entry.message);
      }
    }
  } catch (error) {
    console.warn("[子代理] 读取最终助手消息失败:", error);
  }
  return "";
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
