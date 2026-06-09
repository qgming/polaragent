import type { AgentConfig } from "@/types/config";
import type { TeamMessage } from "./types";

export function buildTranscript(
  messages: TeamMessage[],
  members: AgentConfig[],
  limit = 14,
): string {
  const nameOf = (agentId?: string) =>
    members.find((m) => m.id === agentId)?.name ?? "成员";
  return messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-limit)
    .map((m) => {
      const speaker = m.role === "user" ? "用户" : nameOf(m.speakerAgentId);
      return `${speaker}：${m.content.replace(/\s+/g, " ").trim().slice(0, 1200)}`;
    })
    .join("\n");
}
