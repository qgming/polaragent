import { Type, type Static } from "typebox";
import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";

import { useConfigStore } from "@/stores/config-store";
import { text, type ToolContext } from "./tool-context";
import { throwIfAborted } from "./tool-progress";

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
      description: "目标助手名称或关键词。需要选择专业助手时，应先调用 list_agents 查看清单再填写。不提供时使用默认助手 default/Cowork。",
    }),
  ),
  temporaryAgentName: Type.Optional(
    Type.String({
      description: "临时子代理名称。需要创建临时子代理时填写，例如“代码审查专家”“资料调研员”。",
    }),
  ),
  temporarySystemPrompt: Type.Optional(
    Type.String({
      description: "临时子代理的角色、能力边界、工作方式和输出要求。提供该字段时会创建临时子代理，而不是只从已安装助手中选择。",
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
      "在普通对话中调用另一个助手作为子代理处理一个明确子任务。未指定目标时使用默认助手 default/Cowork；需要专业助手时先调用 list_agents 查看清单再通过 agentId/agentName 选择；也可提供 temporaryAgentName 和 temporarySystemPrompt 创建临时子代理。适合调研、代码审查、方案对比、测试验证、文案润色、专业判断等可并行或需要第二视角的工作。子代理完成后返回结果，最终回复仍由当前助手整合。",
    parameters: delegateTaskParams,
    execute: async (_id, params: Static<typeof delegateTaskParams>, signal, onUpdate) => {
      throwIfAborted(signal);
      if (ctx.isSubagent) {
        return {
          content: text("当前已经在子代理中，不能再次调用子代理。请直接完成当前任务并返回结果。"),
          details: { error: "recursive_delegation_blocked" },
        };
      }

      const agents = useConfigStore.getState().agents;
      const requesterId = ctx.requester?.id;
      const temporarySystemPrompt = params.temporarySystemPrompt?.trim();
      const useTemporary = Boolean(temporarySystemPrompt);
      const hasExplicitInstalledTarget = Boolean(params.agentId?.trim() || params.agentName?.trim());
      const installedTarget = useTemporary
        ? undefined
        : hasExplicitInstalledTarget
          ? findAgentById(agents, params.agentId) ?? findAgentByName(agents, params.agentName)
          : findDefaultCoworkAgent(agents);
      const temporaryName =
        params.temporaryAgentName?.trim() ||
        params.agentName?.trim() ||
        "临时子代理";

      if (!useTemporary && agents.length === 0) {
        return {
          content: text("当前没有可用助手，无法调用子代理。可提供 temporaryAgentName 和 temporarySystemPrompt 创建临时子代理。"),
          details: { error: "no_agents" },
        };
      }

      if (!useTemporary && !installedTarget) {
        return {
          content: text(
            hasExplicitInstalledTarget
              ? "没有找到指定的子代理。请先调用 list_agents 查看可用助手清单，或提供 temporaryAgentName 和 temporarySystemPrompt 创建临时子代理。"
              : "没有找到默认子代理 default/Cowork。请先调用 list_agents 查看可用助手清单并显式选择，或提供 temporaryAgentName 和 temporarySystemPrompt 创建临时子代理。",
          ),
          details: {
            error: hasExplicitInstalledTarget ? "agent_not_found" : "default_agent_not_found",
          },
        };
      }

      const parentThreadId = ctx.parentThreadId ?? ctx.threadId;
      const target = useTemporary
        ? {
            id: requesterId || "default",
            name: temporaryName,
            kind: "temporary" as const,
            systemPrompt: temporarySystemPrompt,
          }
        : {
            id: installedTarget!.id,
            name: installedTarget!.name,
            kind: "installed" as const,
            systemPrompt: undefined,
          };
      const childSessionId = makeChildSessionId(parentThreadId, `${target.kind}_${target.name}_${target.id}`);
      const prompt = buildSubagentPrompt({
        task: params.task,
        context: params.context,
        parentThreadId,
        requesterName: ctx.requester?.name,
      });

      try {
        throwIfAborted(signal);
        onUpdate?.({
          content: text(`正在调用子代理 ${target.name}...`),
          details: {
            agentId: target.id,
            agentName: target.name,
            agentKind: target.kind,
            phase: "starting",
          },
        });

        const { agentManager } = await import("@/ai/agent-manager");
        throwIfAborted(signal);
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
            agentName: target.name,
            systemPrompt: target.systemPrompt,
          },
        });
        const abortSubagent = () => harness.abort();
        signal?.addEventListener("abort", abortSubagent, { once: true });

        try {
          throwIfAborted(signal);
          onUpdate?.({
            content: text(`子代理 ${target.name} 正在执行任务...`),
            details: {
              agentId: target.id,
              agentName: target.name,
              agentKind: target.kind,
              childSessionId,
              phase: "running",
            },
          });

          const response = await harness.prompt(prompt);
          await harness.waitForIdle();
          throwIfAborted(signal);
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
            agentId: target.id,
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

function findAgentById(
  agents: ReturnType<typeof useConfigStore.getState>["agents"],
  agentId?: string,
) {
  if (!agentId?.trim()) return undefined;
  return agents.find((agent) => agent.id === agentId.trim());
}

function findDefaultCoworkAgent(
  agents: ReturnType<typeof useConfigStore.getState>["agents"],
) {
  return (
    agents.find((agent) => agent.id === "default") ??
    agents.find((agent) => agent.name.trim().toLocaleLowerCase() === "cowork")
  );
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
