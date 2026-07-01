import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TeamMessage } from "@/lib/team";
import {
  GUIDANCE_ENTRY,
  TEAM_SPEAKER_ENTRY,
  TEAM_VOTE_ENTRY,
} from "./entries";
import { openOrCreateSession, openOrCreateTeamSession } from "./lifecycle";

export async function appendGuidanceMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(GUIDANCE_ENTRY, {
      text,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(`写入会话引导失败 ${sessionId}:`, error);
  }
}

export async function appendTeamGuidanceMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(GUIDANCE_ENTRY, {
      text,
      createdAt: Date.now(),
    });
  } catch (error) {
    console.error(`写入团队会话引导失败 ${sessionId}:`, error);
  }
}

export async function appendTeamSpeaker(
  sessionId: string,
  agentId: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_SPEAKER_ENTRY, { agentId });
  } catch (error) {
    console.error(`写入团队发言成员失败 ${sessionId}:`, error);
  }
}

export async function appendTeamVoteMessage(
  sessionId: string,
  message: TeamMessage,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_VOTE_ENTRY, { message });
  } catch (error) {
    console.error(`写入团队投票失败 ${sessionId}:`, error);
  }
}

export async function appendTeamUserMessage(
  sessionId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    // 构造完整的 UserMessage（包含 timestamp 必填字段）
    await session.appendMessage({
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as AgentMessage);
  } catch (error) {
    console.error(`写入团队用户消息失败 ${sessionId}:`, error);
  }
}

export async function appendTeamAssistantMessage(
  sessionId: string,
  agentId: string,
  text: string,
): Promise<void> {
  try {
    const session = await openOrCreateTeamSession(sessionId);
    await session.appendCustomEntry(TEAM_SPEAKER_ENTRY, { agentId });
    // 构造完整的 AssistantMessage（包含所有必填字段）
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "polaragent",
      model: "team-mirror",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    } as AgentMessage);
  } catch (error) {
    console.error(`写入团队成员发言失败 ${sessionId}:`, error);
  }
}
