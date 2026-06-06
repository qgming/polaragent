// control_team_flow —— 团队成员用结构化信号控制接力、结束与私聊提示

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { setTeamControlSignal, type TeamFlowAction } from "@/ai/team-control";
import { text, type ToolContext } from "./tool-context";

const controlTeamFlowParams = Type.Object({
  action: Type.Union([
    Type.Literal("continue"),
    Type.Literal("handoff"),
    Type.Literal("finish"),
    Type.Literal("blocked"),
  ], {
    description:
      "团队流程动作：continue=继续但不指定人；handoff=交接给下一位；finish=任务完成；blocked=无法继续。",
  }),
  nextAgentId: Type.Optional(
    Type.String({
      description:
        "要交接的下一位成员 agentId。action=handoff 时建议填写，必须来自当前团队成员。",
    }),
  ),
  nextAgentName: Type.Optional(
    Type.String({
      description:
        "要交接的下一位成员名称。nextAgentId 不确定时可填写名称，系统会匹配当前团队成员。",
    }),
  ),
  privateMessage: Type.Optional(
    Type.String({
      description:
        "给下一位成员的私聊提示。它不会进入公开团队讨论转写，只有用户能在工具调用里看到，并会只注入给下一位成员。",
    }),
  ),
  reason: Type.String({
    description: "为什么做这个流程决定，简短说明依据。",
  }),
  confidence: Type.Optional(
    Type.Number({
      description: "你对这个流程决定的置信度，0 到 1。",
      minimum: 0,
      maximum: 1,
    }),
  ),
});

export function controlTeamFlowTool(
  ctx: ToolContext,
): AgentTool<typeof controlTeamFlowParams> {
  return {
    name: "control_team_flow",
    label: "控制团队流程",
    description:
      "在团队协作中结构化控制下一步：继续、交接给指定成员、结束或标记阻塞。" +
      "选择下一位成员时可以附带 privateMessage 私聊提示；该提示不进入公开讨论，只会注入给下一位成员。",
    parameters: controlTeamFlowParams,
    execute: async (_id, params: Static<typeof controlTeamFlowParams>) => {
      const flowContext = ctx.teamFlow;
      if (!flowContext) {
        throw new Error("当前会话不是团队协作会话");
      }

      const action = params.action as TeamFlowAction;
      const reason = params.reason.trim();
      if (!reason) {
        throw new Error("reason 不能为空");
      }

      const requestedId = params.nextAgentId?.trim();
      const requestedName = params.nextAgentName?.trim();
      const nextMember =
        (requestedId
          ? flowContext.members.find((member) => member.id === requestedId)
          : undefined) ??
        (requestedName
          ? flowContext.members.find((member) => member.name === requestedName) ??
            flowContext.members.find((member) =>
              member.name.includes(requestedName),
            ) ??
            flowContext.members.find((member) =>
              requestedName.includes(member.name),
            )
          : undefined);

      if (action === "handoff" && !nextMember) {
        throw new Error("handoff 需要指定当前团队中的下一位成员");
      }

      if (nextMember?.id === flowContext.currentAgentId) {
        throw new Error("不能把流程交接给自己");
      }

      const confidence =
        typeof params.confidence === "number"
          ? Math.max(0, Math.min(1, params.confidence))
          : 0.7;
      const privateMessage = params.privateMessage?.trim();

      const signal = {
        action,
        nextAgentId: nextMember?.id,
        nextAgentName: nextMember?.name,
        privateMessage,
        reason,
        confidence,
      };

      setTeamControlSignal(
        flowContext.threadId,
        flowContext.currentAgentId,
        signal,
      );

      const summary = [
        `动作：${action}`,
        nextMember ? `下一位：${nextMember.name}` : "",
        privateMessage ? `私聊提示：${privateMessage}` : "",
        `原因：${reason}`,
        `置信度：${confidence.toFixed(2)}`,
      ]
        .filter(Boolean)
        .join("\n");

      return {
        content: text(summary),
        details: {
          signal,
        },
        terminate:
          action === "handoff" ||
          action === "finish" ||
          action === "blocked",
      };
    },
  };
}
