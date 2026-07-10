import { Type, type Static } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";

const delegateTaskParams = Type.Object({
  task: Type.String({
    description: "交给子代理完成的清晰任务。应包含目标、范围、期望输出。",
    minLength: 1,
  }),
  agentId: Type.Optional(
    Type.String({
      description: "目标助手 ID。已知精确 ID 时优先提供。",
    }),
  ),
  agentName: Type.Optional(
    Type.String({
      description: "目标助手名称或关键词。不提供时自动选择一个非当前助手。",
    }),
  ),
  context: Type.Optional(
    Type.String({
      description: "补充给子代理的上下文、约束、用户原始需求或当前进展。",
    }),
  ),
});

export function delegateTaskTool(ctx: ToolContext): AgentTool<typeof delegateTaskParams> {
  return {
    name: "delegate_task",
    label: "调用子代理",
    description:
      "在普通对话中调用另一个助手作为子代理处理一个明确子任务。适合调研、代码审查、方案对比、测试验证、文案润色、专业判断等可并行或需要第二视角的工作。子代理完成后返回结果，最终回复仍由当前助手整合。",
    parameters: delegateTaskParams,
    execute: async (_id, params: Static<typeof delegateTaskParams>) => {
      if (ctx.isSubagent) {
        return {
          content: text("当前已经在子代理中，不能再次调用子代理。请直接完成当前任务并返回结果。"),
          details: { error: "recursive_delegation_blocked" },
        };
      }

      const agents = useConfigStore.getState().agents;
      if (agents.length === 0) {
        return {
          content: text("当前没有可用助手，无法调用子代理。"),
          details: { error: "no_agents" },
        };
      }

      const requesterId = ctx.requester?.id;
      const target =
        findAgentById(agents, params.agentId) ??
        findAgentByName(agents, params.agentName) ??
        agents.find((agent) => agent.id !== requesterId) ??
        agents[0];

      if (!target) {
        return {
          content: text("没有找到可调用的子代理。"),
          details: { error: "agent_not_found" },
        };
      }

      const parentThreadId = ctx.parentThreadId ?? ctx.threadId;
      const childSessionId = makeChildSessionId(parentThreadId, target.id);
      const prompt = buildSubagentPrompt({
        task: params.task,
        context: params.context,
        parentThreadId,
        requesterName: ctx.requester?.name,
      });

      try {
        const { agentManager } = await import("@/ai/agent-manager");
        const harness = await agentManager.getOrCreateHarness(parentThreadId, target.id, {
          workingDir: ctx.workingDir,
          permissionMode: ctx.permissionMode,
          knowledgeBaseIds: ctx.knowledgeBaseIds,
          projectId: ctx.projectId,
          subagentContext: {
            isSubagent: true,
            parentThreadId,
            parentAgentId: requesterId ?? "",
            sessionId: childSessionId,
            task: params.task,
          },
        });

        const response = await harness.prompt(prompt);
        await harness.waitForIdle();
        const resultText = assistantMessageText(response) || "子代理已完成，但没有返回可提取的文本内容。";
        const content = [
          `子代理 ${target.name} 已完成任务。`,
          "",
          resultText,
        ].join("\n");

        return {
          content: text(content),
          details: {
            agentId: target.id,
            agentName: target.name,
            childSessionId,
            result: resultText,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: text(`子代理 ${target.name} 执行失败：${message}`),
          details: {
            error: "subagent_failed",
            agentId: target.id,
            agentName: target.name,
            childSessionId,
            message,
          },
        };
      }
    },
  };
}

function findAgentById(
  agents: ReturnType<typeof useConfigStore.getState>["agents"],
  agentId?: string,
) {
  if (!agentId?.trim()) return undefined;
  return agents.find((agent) => agent.id === agentId.trim());
}

function findAgentByName(
  agents: ReturnType<typeof useConfigStore.getState>["agents"],
  agentName?: string,
) {
  const needle = agentName?.trim().toLocaleLowerCase();
  if (!needle) return undefined;
  return (
    agents.find((agent) => agent.name.toLocaleLowerCase() === needle) ??
    agents.find((agent) => agent.name.toLocaleLowerCase().includes(needle))
  );
}

function makeChildSessionId(parentThreadId: string, agentId: string): string {
  const safeAgentId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "agent";
  const entropy = Math.random().toString(36).slice(2, 8);
  return `${parentThreadId}__sub_${safeAgentId}_${Date.now()}_${entropy}`;
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
