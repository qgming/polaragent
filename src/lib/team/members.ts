import type { AgentConfig, TeamConfig } from "@/types/config";

export function memberLabel(agent: AgentConfig): string {
  return `${agent.avatar || "⚡"} ${agent.name}`;
}

/**
 * 某成员在团队会话里的独立 session id（每成员一个文件，互不污染历史）。
 * session id 会进入文件名，所以把非安全字符统一替换为 "-"。
 */
export function memberSessionId(threadId: string, agentId: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9一-龥_-]/g, "-");
  return `${threadId}__m_${safeAgent}`;
}

export function buildIdentityPrefix(
  team: TeamConfig,
  self: AgentConfig,
  members: AgentConfig[],
): string {
  const roster = members
    .map(
      (m) =>
        `- ${m.name}${m.id === team.leaderId ? "（领导）" : ""}：${m.description || "（无简介）"}`,
    )
    .join("\n");
  const leaderName = members.find((m) => m.id === team.leaderId)?.name || "领导";

  return [
    `你是团队「${team.name}」的成员「${self.name}」${team.mode === "leader" ? `，由领导「${leaderName}」调度` : ""}。`,
    `团队成员名单：\n${roster}`,
    team.mode === "leader"
      ? "协作模式：本团队采用领导模式。领导负责统筹全局、分配任务；你应聚焦自己的专长。需要交接、结束或标记阻塞时，优先调用 control_team_flow 工具。"
      : "协作模式：本团队采用头脑风暴模式。所有成员地位平等，自由提出不同角度、补充想法和质疑。需要交接、结束或标记阻塞时，优先调用 control_team_flow 工具。",
    "control_team_flow 是团队流程控制工具：用它选择下一位发言人、传递只给下一位成员看的私聊提示或结束本轮协作。私聊提示不会进入公开讨论转写。",
    "ask_user 是面向用户的独立输入工具：当缺少用户偏好、确认、素材或选项决策时，用它向用户请求 input 自由输入、single 单选或 multiple 多选；prompt 支持 Markdown，single/multiple 会自动追加最后的自定义输入选项。不要把询问用户塞进 control_team_flow。",
    "所有团队协作模式都可以调用 request_team_vote 工具发起投票；需要共同决策、选择方案或确认是否结束任务时必须用工具发起投票，不要用 [VOTE:...] 这类文本暗号触发投票。",
    "投票由软件在后台依次调度每个成员完成；投票结束前你看不到其他成员的投票选择，全部完成后才会看到汇总结果。",
    "对话中带 <discussion> 标签的内容是团队此前的讨论记录（含其他成员发言），仅供你参考，不要复述或逐条总结它。",
    team.mode === "equal"
      ? "不要试图主导全局或替队友发言，尊重每个人的独立视角。请只以「你自己」的身份、用第一人称输出你这一轮要说的话。"
      : "请只以「你自己」的身份、用第一人称输出你这一轮要说的话，聚焦你的专长，简洁推进任务。",
  ].join("\n\n");
}

export function parseMentions(
  text: string,
  members: AgentConfig[],
  excludeId?: string,
): string[] {
  const matches = text.match(/@([^\s@,，。.!！?？:：、]+)/g);
  if (!matches) return [];
  const ids: string[] = [];
  for (const raw of matches) {
    const name = raw.slice(1);
    const hit =
      members.find((m) => m.name === name) ??
      members.find((m) => name.startsWith(m.name)) ??
      members.find((m) => m.name.startsWith(name) && name.length >= 2);
    if (hit && hit.id !== excludeId && !ids.includes(hit.id)) ids.push(hit.id);
  }
  return ids;
}

export function pickMentionedSpeaker(
  userInput: string,
  members: AgentConfig[],
): AgentConfig | undefined {
  const [mentionedId] = parseMentions(userInput, members);
  return mentionedId
    ? members.find((member) => member.id === mentionedId)
    : undefined;
}

export function selectRandomSpeaker(
  members: AgentConfig[],
  excludeIds: string[],
): AgentConfig | null {
  const candidates = members.filter((m) => !excludeIds.includes(m.id));
  if (candidates.length === 0) return null;

  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}
