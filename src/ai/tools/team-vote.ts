// request_team_vote —— 团队成员发起投票
// src/ai/tools/team-vote.ts

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { text, type ToolContext } from "./context";

const requestTeamVoteParams = Type.Object({
  topic: Type.String({ description: "投票主题或要决策的问题" }),
  options: Type.Array(
    Type.String({ description: "投票选项的简短标签" }),
    {
      description: "投票选项，至少 2 个，建议 2-5 个",
      minItems: 2,
      maxItems: 8,
    },
  ),
});

const castTeamVoteParams = Type.Object({
  optionId: Type.String({
    description: "你选择的投票选项 ID，必须是本轮投票给出的 optionId 之一",
  }),
});

export function requestTeamVoteTool(
  ctx: ToolContext,
): AgentTool<typeof requestTeamVoteParams> {
  return {
    name: "request_team_vote",
    label: "发起团队投票",
    description:
      "在团队内部发起一次投票决策。适合需要成员共同决定是否结束任务、选择方案、确认方向时使用。" +
      "调用后会向所有团队成员收集投票，并把投票卡片显示在团队对话和团队监控面板中。",
    parameters: requestTeamVoteParams,
    execute: async (_id, params: Static<typeof requestTeamVoteParams>) => {
      const voteContext = ctx.teamVote;
      if (!voteContext) {
        throw new Error("当前会话不是团队协作会话");
      }

      const topic = params.topic.trim();
      const optionLabels = params.options
        .map((option) => option.trim())
        .filter(Boolean);

      if (!topic) {
        throw new Error("投票主题不能为空");
      }
      if (optionLabels.length < 2) {
        throw new Error("投票至少需要 2 个有效选项");
      }

      const options = optionLabels.map((label, index) => ({
        id: `option_${index}`,
        label,
      }));

      const { initiateVote } = await import("@/ai/team-vote");
      const result = await initiateVote(
        ctx.threadId,
        voteContext.team,
        voteContext.initiatorId,
        topic,
        options,
      );

      return {
        content: text(JSON.stringify(result, null, 2)),
        details: {
          vote: result,
        },
      };
    },
  };
}

export function castTeamVoteTool(
  ctx: ToolContext,
): AgentTool<typeof castTeamVoteParams> {
  return {
    name: "cast_team_vote",
    label: "提交团队投票",
    description:
      "在团队投票收集阶段提交你自己的投票。必须从给定选项中选择一个 optionId；" +
      "不要替其他成员投票，也不要在工具参数以外透露你的选择。",
    parameters: castTeamVoteParams,
    executionMode: "sequential",
    execute: async (_id, params: Static<typeof castTeamVoteParams>) => {
      const castContext = ctx.teamCastVote;
      if (!castContext) {
        throw new Error("当前不在团队投票收集阶段");
      }

      const optionId = params.optionId.trim();
      const option = castContext.options.find((item) => item.id === optionId);
      if (!option) {
        throw new Error("无效的投票选项 ID");
      }

      castContext.onCast(option.id);

      return {
        content: text("投票已提交。"),
        details: {
          voteId: castContext.voteId,
          voterId: castContext.voterId,
          optionId: option.id,
        },
        terminate: true,
      };
    },
  };
}
