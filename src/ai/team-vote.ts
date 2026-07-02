// 团队通用投票机制 —— 软件调度、成员必须调用工具投票
// src/ai/team-vote.ts

import { agentManager, type TeamContext } from "./agent-manager";
import { appendTeamVoteMessage } from "@/lib/session/team";
import { useConfigStore } from "@/stores/config-store";
import { useTeamChatStore } from "@/stores/team/team-chat-store";
import { buildTranscript, type TeamMessage } from "@/lib/team";
import type { AgentConfig, TeamConfig } from "@/types/config";

type TeamVoteState = NonNullable<TeamMessage["vote"]>;
type VoteOption = { id: string; label: string };
type VoteRecord = { agentId: string; optionId: string; timestamp: number };
type MemberVoteStatus = NonNullable<TeamVoteState["memberStatuses"]>[number];

export interface TeamVoteResultPayload {
  topic: string;
  options: Array<{
    id: string;
    label: string;
    count: number;
    voters: Array<{
      agentId: string;
      name: string;
    }>;
  }>;
  topOptionIds: string[];
  maxVotes: number;
}

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `vote-${Date.now()}-${Math.random().toString(36).slice(2)}`;

function voteSessionId(threadId: string, voteId: string, agentId: string): string {
  const safeVote = voteId.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeAgent = agentId.replace(/[^a-zA-Z0-9一-龥_-]/g, "-");
  return `${threadId}__vote_${safeVote}__m_${safeAgent}`;
}

/**
 * 发起通用投票。投票由软件依次调度所有成员完成；成员必须调用 cast_team_vote 才算落票。
 */
export async function initiateVote(
  threadId: string,
  team: TeamConfig,
  initiatorId: string,
  topic: string,
  options: VoteOption[],
): Promise<TeamVoteResultPayload | null> {
  const allAgents = useConfigStore.getState().agents;
  const members = team.memberIds
    .map((id) => allAgents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentConfig => !!agent);

  if (members.length === 0) {
    throw new Error("团队没有可投票成员");
  }

  const voteMessageId = createId();
  const initiatorName =
    members.find((member) => member.id === initiatorId)?.name ?? "成员";
  const now = Date.now();
  const initialStatuses: MemberVoteStatus[] = members.map((member) => ({
    agentId: member.id,
    status: "pending",
    updatedAt: now,
  }));
  const initialVote: TeamVoteState = {
    topic,
    initiatorId,
    options,
    votes: [],
    memberStatuses: initialStatuses,
    status: "pending",
  };

  const voteMessage: TeamMessage = {
    id: voteMessageId,
    role: "assistant",
    content: `投票：${topic}\n\n发起人：${initiatorName}\n\n正在依次收集团队成员投票，结果会在全部成员完成后公开。`,
    createdAt: now,
    status: "complete",
    speakerAgentId: initiatorId,
    vote: initialVote,
  };

  const votes: VoteRecord[] = [];
  const statuses = [...initialStatuses];

  useTeamChatStore.getState().appendMessage(threadId, voteMessage);
  await appendTeamVoteMessage(threadId, voteMessage);
  updateVoteProgress(threadId, voteMessageId, voteMessage, initialStatuses, votes);

  // 并行发起所有成员投票，并为每个投票添加 30 秒超时控制
  const VOTE_TIMEOUT_MS = 30000;
  const votePromises = members.map((member) =>
    Promise.race([
      collectMemberVoteByTool({
        threadId,
        team,
        voteId: voteMessageId,
        member,
        members,
        topic,
        options,
      }),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("投票超时")), VOTE_TIMEOUT_MS),
      ),
    ])
      .then((optionId) => ({ member, optionId, error: null as null }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`成员 ${member.name} 投票失败:`, message);
        return { member, optionId: null as string | null, error };
        // 允许部分成员投票失败，后续统计有效票
      }),
  );

  // 先统一标记所有成员为 voting 状态
  members.forEach((member) => {
    setMemberVoteStatus(statuses, member.id, "voting");
  });
  updateVoteProgress(threadId, voteMessageId, voteMessage, statuses, votes);

  // 等待所有投票完成（并行执行）
  const voteResults = await Promise.all(votePromises);

  // 收集有效投票结果
  for (const result of voteResults) {
    if (result.optionId && result.error === null) {
      votes.push({
        agentId: result.member.id,
        optionId: result.optionId,
        timestamp: Date.now(),
      });
      setMemberVoteStatus(statuses, result.member.id, "voted");
    } else {
      setMemberVoteStatus(
        statuses,
        result.member.id,
        "failed",
        result.error instanceof Error ? result.error.message : String(result.error),
      );
    }
    updateVoteProgress(threadId, voteMessageId, voteMessage, statuses, votes);
  }

  // 如果没有任何有效投票，则视为全部失败，抛出异常
  if (votes.length === 0) {
    const allFailedMessage: TeamMessage = {
      ...voteMessage,
      content: formatVoteCancelled(topic, statuses, members),
      vote: {
        ...initialVote,
        votes: [...votes],
        memberStatuses: [...statuses],
        status: "cancelled",
      },
    };
    useTeamChatStore.getState().updateMessage(threadId, voteMessageId, {
      content: allFailedMessage.content,
      vote: allFailedMessage.vote,
    });
    await appendTeamVoteMessage(threadId, allFailedMessage);
    throw new Error("所有成员投票失败，投票已取消");
  }

  const result = calculateVoteResult(topic, votes, options, members);
  const finalMessage: TeamMessage = {
    ...voteMessage,
    content: formatVoteResult(result),
    vote: {
      ...initialVote,
      votes,
      memberStatuses: [...statuses],
      status: "completed",
      result,
    },
  };

  useTeamChatStore.getState().updateMessage(threadId, voteMessageId, {
    content: finalMessage.content,
    vote: finalMessage.vote,
  });
  await appendTeamVoteMessage(threadId, finalMessage);

  return result;
}

async function collectMemberVoteByTool({
  threadId,
  team,
  voteId,
  member,
  members,
  topic,
  options,
}: {
  threadId: string;
  team: TeamConfig;
  voteId: string;
  member: AgentConfig;
  members: AgentConfig[];
  topic: string;
  options: VoteOption[];
}): Promise<string> {
  let selectedOptionId: string | null = null;
  const optionsText = options
    .map((option) => `- ${option.id}: ${option.label}`)
    .join("\n");
  const transcript = buildVoteTranscript(threadId, members);
  const teamContext: TeamContext = {
    isTeam: true,
    extraSkillIds: [],
    teamSystemPrompt: "",
    identityPrefix: [
      `你是团队「${team.name}」的成员「${member.name}」。`,
      "你正在参加一次后台团队投票。你必须调用 cast_team_vote 工具提交自己的选择。",
      "投票结束前，你看不到其他成员的投票选择；不要猜测、询问或输出其他成员的选择。",
      "只根据团队讨论、投票主题和选项独立判断。不要用普通文本回复代替工具调用。",
    ].join("\n\n"),
    sessionId: voteSessionId(threadId, voteId, member.id),
    voteCasting: {
      voteId,
      voterId: member.id,
      options,
      onCast: (optionId) => {
        selectedOptionId = optionId;
      },
    },
  };

  const harness = await agentManager.getOrCreateHarness(threadId, member.id, {
    teamContext,
    knowledgeBaseIds: teamContext.knowledgeBaseIds,
  });

  const unsubscribe = harness.subscribe((event) => {
    if (
      event.type === "tool_execution_end" &&
      event.toolName === "cast_team_vote" &&
      !event.isError
    ) {
      const details = (event.result as { details?: { optionId?: unknown } })
        .details;
      if (typeof details?.optionId === "string") {
        selectedOptionId = details.optionId;
      }
    }
  });

  const prompt = [
    transcript ? `<discussion>\n${transcript}\n</discussion>` : "",
    `投票主题：${topic}`,
    `可选项：\n${optionsText}`,
    "请立即调用 cast_team_vote 工具提交你的投票。工具参数 optionId 必须完全等于上方某个选项 ID。",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    await harness.prompt(prompt);
    await harness.waitForIdle();
  } finally {
    unsubscribe();
  }

  if (!selectedOptionId) {
    throw new Error("成员没有调用 cast_team_vote 工具提交投票");
  }

  return selectedOptionId;
}

function buildVoteTranscript(
  threadId: string,
  members: AgentConfig[],
  limit = 14,
): string {
  const thread = useTeamChatStore
    .getState()
    .threads.find((item) => item.id === threadId);
  if (!thread) return "";

  return buildTranscript(
    thread.messages.filter((message) => !message.vote),
    members,
    limit,
  );
}

function setMemberVoteStatus(
  statuses: MemberVoteStatus[],
  agentId: string,
  status: MemberVoteStatus["status"],
  error?: string,
): void {
  const index = statuses.findIndex((item) => item.agentId === agentId);
  if (index < 0) return;
  statuses[index] = {
    agentId,
    status,
    updatedAt: Date.now(),
    error,
  };
}

function updateVoteProgress(
  threadId: string,
  voteMessageId: string,
  baseMessage: TeamMessage,
  statuses: MemberVoteStatus[],
  votes: VoteRecord[],
): void {
  const pendingVote = baseMessage.vote
    ? {
        ...baseMessage.vote,
        votes: [...votes],
        memberStatuses: [...statuses],
        status: "pending" as const,
      }
    : undefined;
  useTeamChatStore.getState().updateMessage(threadId, voteMessageId, {
    vote: pendingVote,
  });
}

function calculateVoteResult(
  topic: string,
  votes: VoteRecord[],
  options: VoteOption[],
  members: AgentConfig[],
): TeamVoteResultPayload {
  const counts = new Map<string, number>();
  options.forEach((option) => counts.set(option.id, 0));
  votes.forEach((vote) => {
    counts.set(vote.optionId, (counts.get(vote.optionId) ?? 0) + 1);
  });

  const maxVotes = Math.max(0, ...Array.from(counts.values()));
  const topOptionIds =
    maxVotes > 0
      ? options
          .filter((option) => (counts.get(option.id) ?? 0) === maxVotes)
          .map((option) => option.id)
      : [];

  return {
    topic,
    options: options.map((option) => ({
      id: option.id,
      label: option.label,
      count: counts.get(option.id) ?? 0,
      voters: votes
        .filter((vote) => vote.optionId === option.id)
        .map((vote) => ({
          agentId: vote.agentId,
          name:
            members.find((member) => member.id === vote.agentId)?.name ??
            "未知成员",
        })),
    })),
    topOptionIds,
    maxVotes,
  };
}

function formatVoteResult(result: TeamVoteResultPayload): string {
  const lines = [`投票：${result.topic}`, "", "详细结果："];
  result.options.forEach((option) => {
    const voters = option.voters.map((voter) => voter.name);
    const topMark = result.topOptionIds.includes(option.id) ? "[最高票] " : "";
    lines.push(
      `${topMark}${option.label}：${option.count} 票${
        voters.length > 0 ? ` (${voters.join(", ")})` : ""
      }`,
    );
  });

  return lines.join("\n");
}

function formatVoteCancelled(
  topic: string,
  statuses: MemberVoteStatus[],
  members: AgentConfig[],
): string {
  const failed = statuses.filter((item) => item.status === "failed");
  const names = failed.map((item) => {
    const name =
      members.find((member) => member.id === item.agentId)?.name ?? "未知成员";
    return item.error ? `${name}（${item.error}）` : name;
  });

  return [
    `投票：${topic}`,
    "",
    "投票未完成：有成员未通过 cast_team_vote 工具提交投票。",
    names.length > 0 ? `失败成员：${names.join("、")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
