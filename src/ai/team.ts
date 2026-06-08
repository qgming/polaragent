// 团队运行时 —— 支持领导模式、头脑风暴模式与并行模式
// src/ai/team.ts
//
// 领导模式（中心化 group chat 编排 + LLM 自动点名）：
//   - 每个成员用各自独立的 pi Session（teams/conversations 下 `${threadId}::${agentId}`），
//     避免把队友的输出当成自己的历史而反复复述。
//   - 团队的「合并对话」以 team-chat-store 为权威，并镜像持久化到 threadId 这条
//     团队会话（authored user/assistant 消息 + team_speaker 标记），供重启回读。
//   - 每个成员发言前，把「截至目前的团队讨论转写」作为输入注入（<discussion> 块），
//     让成员看到他人贡献且正确归属；成员的私有 session 仅累积自己的轮次。
//   - 接力（谁下一个发言）：成员用 control_team_flow 工具显式交接/结束。
//   - 防失控：maxRounds 上限 + 同一人连续发言上限（避免原地打转）。
//
// 平等模式（头脑风暴）：
//   - 随机选择首个发言者（用户 @ 指定优先）
//   - 成员自由补充观点，用 control_team_flow 工具交接/结束
//   - 无指定时随机选人（排除刚说过的）
//   - 支持投票决策机制
//
// 并行模式：
//   - 用户 @ 指定多个成员时并发触发这些成员，否则并发触发全员
//   - 成员输出互不等待，完成后由领导/首位成员做一次汇总

import { promptAgent } from "./agent";
import { agentManager, type TeamContext } from "./agent-manager";
import {
  clearTeamControlSignal,
  consumeTeamControlSignal,
  type TeamControlSignal,
} from "./team-control";
import { cancelAskUserRequestsForThread } from "./ask-user";
import {
  appendTeamAssistantMessage,
  appendTeamUserMessage,
  getTeamSessionFilesDir,
  ensureTeamSessionFilesDir,
} from "@/lib/session/session-operations";
import { useConfigStore } from "@/stores/config-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import {
  useTeamChatStore,
  type TeamMessage,
} from "@/stores/team/team-chat-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import type { AgentConfig, TeamConfig } from "@/types/config";

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tmsg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** 取某成员的展示标签：emoji + 名称。 */
function memberLabel(agent: AgentConfig): string {
  return `${agent.avatar || "⚡"} ${agent.name}`;
}

/** 某成员在团队会话里的独立 session id（每成员一个文件，互不污染历史）。
 *  注意：session id 会进入文件名，必须只含文件名安全字符——agentId 可能含
 *  「::」「/」或中文（如 market-产品经理），在 Windows 上 :: 是非法字符（os error 123），
 *  这里把非安全字符统一替换为 "-"，并用「__」连接 threadId 与成员，避免撞键。 */
function memberSessionId(threadId: string, agentId: string): string {
  const safeAgent = agentId.replace(/[^a-zA-Z0-9一-龥_-]/g, "-");
  return `${threadId}__m_${safeAgent}`;
}

/** 构造成员发言时的身份前缀（让模型以第一人称、知晓队友与协作规则）。 */
function buildIdentityPrefix(
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
      : team.mode === "parallel"
        ? "协作模式：本团队采用并行模式。你会和其他成员同时处理同一任务，请只输出你的独立观点、证据、风险或产物，不要替其他成员汇总。"
        : "协作模式：本团队采用头脑风暴模式。所有成员地位平等，自由提出不同角度、补充想法和质疑。需要交接、结束或标记阻塞时，优先调用 control_team_flow 工具。",
    "control_team_flow 是团队流程控制工具：用它选择下一位发言人、传递只给下一位成员看的私聊提示或结束本轮协作。私聊提示不会进入公开讨论转写。",
    "ask_user 是面向用户的独立输入工具：当缺少用户偏好、确认、素材或选项决策时，用它向用户请求纯文本、单选或多选输入；不要把询问用户塞进 control_team_flow。",
    "所有团队协作模式都可以调用 request_team_vote 工具发起投票；需要共同决策、选择方案或确认是否结束任务时必须用工具发起投票，不要用 [VOTE:...] 这类文本暗号触发投票。",
    "投票由软件在后台依次调度每个成员完成；投票结束前你看不到其他成员的投票选择，全部完成后才会看到汇总结果。",
    "对话中带 <discussion> 标签的内容是团队此前的讨论记录（含其他成员发言），仅供你参考，不要复述或逐条总结它。",
    team.mode === "equal"
      ? "不要试图主导全局或替队友发言，尊重每个人的独立视角。请只以「你自己」的身份、用第一人称输出你这一轮要说的话。"
      : "请只以「你自己」的身份、用第一人称输出你这一轮要说的话，聚焦你的专长，简洁推进任务。",
  ].join("\n\n");
}

/** 解析文本里所有匹配团队成员的 @名称。 */
function parseMentions(
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

/** 把团队会话当前消息拼成转写文本（含发言成员归属），供注入/选人参考。 */
function buildTranscript(
  threadId: string,
  members: AgentConfig[],
  limit = 14,
): string {
  const thread = useTeamChatStore
    .getState()
    .threads.find((t) => t.id === threadId);
  if (!thread) return "";
  const nameOf = (agentId?: string) =>
    members.find((m) => m.id === agentId)?.name ?? "成员";
  return thread.messages
    .filter((m) => m.content.trim().length > 0)
    .slice(-limit)
    .map((m) => {
      const speaker = m.role === "user" ? "用户" : nameOf(m.speakerAgentId);
      return `${speaker}：${m.content.replace(/\s+/g, " ").trim().slice(0, 1200)}`;
    })
    .join("\n");
}

/**
 * 让某成员发言一轮：在 store 写入一条带 speakerAgentId 的 assistant 消息并流式填充，
 * 用该成员独立 session 运行 harness，输入里注入截至目前的团队讨论转写。
 * 返回该成员本轮的最终正文（供解析 @接力）。
 */
async function runMemberTurn(
  threadId: string,
  team: TeamConfig,
  speaker: AgentConfig,
  members: AgentConfig[],
  userTask: string,
  isFirstTurn: boolean,
  workingDir: string | undefined,
  privateMessage?: string,
): Promise<{ content: string; control: TeamControlSignal | null }> {
  const store = useTeamChatStore.getState();
  const assistantId = createId();
  clearTeamControlSignal(threadId, speaker.id);

  const placeholder: TeamMessage = {
    id: assistantId,
    role: "assistant",
    content: "",
    createdAt: Date.now(),
    status: "streaming",
    speakerAgentId: speaker.id,
  };
  store.appendMessage(threadId, placeholder);

  // 注入「团队讨论转写」+ 本轮指令（成员的私有 session 不含队友历史，故每轮注入）
  const transcript = buildTranscript(threadId, members);
  const instruction = isFirstTurn
    ? `用户的任务：${userTask}\n\n请作为「${speaker.name}」开始处理。`
    : `请作为「${speaker.name}」基于上面的团队讨论，给出你这一轮的发言（不要复述讨论内容）。`;
  const privateBlock = privateMessage?.trim()
    ? `<private_message>\n${privateMessage.trim()}\n</private_message>`
    : "";
  const modelInput = transcript
    ? `<discussion>\n${transcript}\n</discussion>\n\n${instruction}`
    : instruction;
  const finalModelInput = privateBlock
    ? `${privateBlock}\n\n${modelInput}`
    : modelInput;

  const teamContext: TeamContext = {
    isTeam: true,
    extraSkillIds: team.enabledSkills ?? [],
    teamSystemPrompt: team.systemPrompt ?? "",
    identityPrefix: buildIdentityPrefix(team, speaker, members),
    sessionId: memberSessionId(threadId, speaker.id),
    teamConfig: team,
    currentAgentId: speaker.id,
    members,
  };

  let finalContent = "";

  await new Promise<void>((resolve) => {
    void promptAgent(
      finalModelInput,
      {
        onStreamUpdate: (update) =>
          useTeamChatStore
            .getState()
            .applyStreamingUpdate(threadId, assistantId, update),
        onDone: ({ content, model, usage, segments }) => {
          finalContent = content;
          useTeamChatStore
            .getState()
            .finishMessage(threadId, assistantId, content, {
              model,
              tokenCount: usage.totalTokens,
              segments,
            });
          // 累计两条含正文的成员发言后，自动生成会话标题（仅一次）
          void useTeamChatStore.getState().maybeAutoGenerateTeamTitle(threadId);
          resolve();
        },
        onError: (message) => {
          useTeamChatStore
            .getState()
            .failMessage(threadId, assistantId, message);
          resolve();
        },
      },
      speaker.id,
      {
        threadId,
        workingDir,
        messageId: assistantId,
        teamContext,
      },
    );
  });

  // 把该成员发言镜像到团队权威会话（供重启回读还原「谁说了什么」）
  if (finalContent.trim()) {
    await appendTeamAssistantMessage(threadId, speaker.id, finalContent);
  }
  const control = consumeTeamControlSignal(threadId, speaker.id);
  return { content: finalContent, control };
}

function controlNextId(
  signal: TeamControlSignal | null,
): string | null | undefined {
  if (!signal) return undefined;
  if (
    signal.action === "finish" ||
    signal.action === "blocked"
  ) {
    return null;
  }
  if (signal.action === "handoff") return signal.nextAgentId ?? null;
  return undefined;
}

function pickMentionedSpeaker(
  userInput: string,
  members: AgentConfig[],
): AgentConfig | undefined {
  const [mentionedId] = parseMentions(userInput, members);
  return mentionedId
    ? members.find((member) => member.id === mentionedId)
    : undefined;
}

/**
 * 团队领导模式主流程。userInput 为用户本轮输入（含可能的 @成员）。
 */
async function promptTeamLeader(
  threadId: string,
  userInput: string,
): Promise<void> {
  const thread = useTeamChatStore
    .getState()
    .threads.find((x) => x.id === threadId);
  const team = thread
    ? useTeamsStore.getState().teams.find((t) => t.id === thread.teamId)
    : undefined;
  if (!team) {
    console.error("找不到团队会话对应的团队:", threadId);
    return;
  }

  const allAgents = useConfigStore.getState().agents;
  const members = team.memberIds
    .map((id) => allAgents.find((a) => a.id === id))
    .filter((a): a is AgentConfig => !!a);
  if (members.length === 0) {
    console.error("团队没有可用成员:", team.id);
    return;
  }

  const store = useTeamChatStore.getState();

  // 工作目录：会话级绑定优先，回退团队配置的 workspaceDir；
  // 若仍无，则自动使用团队会话临时目录（自动创建并绑定）。
  let workingDir =
    thread?.workingDir?.trim() || team.workspaceDir?.trim() || undefined;

  if (!workingDir) {
    // 无工作目录时：使用临时目录（团队会话文件目录）作为默认工作目录
    const tempDir = await getTeamSessionFilesDir(threadId);
    await ensureTeamSessionFilesDir(threadId); // 确保目录存在
    workingDir = tempDir;
    // 绑定到当前团队会话
    store.setTeamThreadWorkingDir(threadId, tempDir);
    useTeamMonitorStore.getState().setWorkingDir(threadId, tempDir);
  }

  // 1) 写入用户消息（store + 权威会话）
  const userMessage: TeamMessage = {
    id: createId(),
    role: "user",
    content: userInput,
    createdAt: Date.now(),
    status: "complete",
  };
  store.appendMessage(threadId, userMessage);
  await appendTeamUserMessage(threadId, userInput);

  // 2) 首个发言者：用户 @ 指定 > 领导
  const leader = members.find((m) => m.id === team.leaderId) ?? members[0];
  let speaker: AgentConfig | undefined =
    pickMentionedSpeaker(userInput, members) ?? leader;

  const maxRounds = team.maxRounds ?? 8;
  let prevSpeakerId = "";
  let sameSpeakerStreak = 0;
  let privateMessage: string | undefined;

  for (let round = 0; round < maxRounds && speaker; round++) {
    const result = await runMemberTurn(
      threadId,
      team,
      speaker,
      members,
      userInput,
      round === 0,
      workingDir,
      privateMessage,
    );
    const currentId: string = speaker.id;
    privateMessage = undefined;

    // 同一人连续发言上限保护
    sameSpeakerStreak = currentId === prevSpeakerId ? sameSpeakerStreak + 1 : 0;
    prevSpeakerId = currentId;
    if (sameSpeakerStreak >= 2) break;

    const nextId = controlNextId(result.control);
    privateMessage = result.control?.privateMessage;
    if (!nextId) break;
    speaker = members.find((m) => m.id === nextId);
  }
}

/**
 * 随机选择发言者（排除指定 id）
 */
function selectRandomSpeaker(
  members: AgentConfig[],
  excludeIds: string[],
): AgentConfig | null {
  const candidates = members.filter((m) => !excludeIds.includes(m.id));
  if (candidates.length === 0) return null;

  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

/**
 * 团队头脑风暴模式主流程
 */
async function promptTeamEqual(
  threadId: string,
  userInput: string,
): Promise<void> {
  const thread = useTeamChatStore
    .getState()
    .threads.find((x) => x.id === threadId);
  const team = thread
    ? useTeamsStore.getState().teams.find((t) => t.id === thread.teamId)
    : undefined;
  if (!team) {
    console.error("找不到团队会话对应的团队:", threadId);
    return;
  }

  const allAgents = useConfigStore.getState().agents;
  const members = team.memberIds
    .map((id) => allAgents.find((a) => a.id === id))
    .filter((a): a is AgentConfig => !!a);
  if (members.length === 0) {
    console.error("团队没有可用成员:", team.id);
    return;
  }

  const store = useTeamChatStore.getState();

  // 工作目录：会话级绑定优先，回退团队配置的 workspaceDir；
  // 若仍无，则自动使用团队会话临时目录（自动创建并绑定）。
  let workingDir =
    thread?.workingDir?.trim() || team.workspaceDir?.trim() || undefined;

  if (!workingDir) {
    // 无工作目录时：使用临时目录（团队会话文件目录）作为默认工作目录
    const tempDir = await getTeamSessionFilesDir(threadId);
    await ensureTeamSessionFilesDir(threadId); // 确保目录存在
    workingDir = tempDir;
    // 绑定到当前团队会话
    store.setTeamThreadWorkingDir(threadId, tempDir);
    useTeamMonitorStore.getState().setWorkingDir(threadId, tempDir);
  }

  // 1) 写入用户消息
  const userMessage: TeamMessage = {
    id: createId(),
    role: "user",
    content: userInput,
    createdAt: Date.now(),
    status: "complete",
  };
  store.appendMessage(threadId, userMessage);
  await appendTeamUserMessage(threadId, userInput);

  // 2) 首个发言者：用户 @ 指定 > 随机选择
  let speaker: AgentConfig | undefined =
    pickMentionedSpeaker(userInput, members) ??
    selectRandomSpeaker(members, []) ??
    undefined;

  const maxRounds = team.maxRounds ?? 8;
  let prevSpeakerId = "";
  let sameSpeakerStreak = 0;
  let privateMessage: string | undefined;

  for (let round = 0; round < maxRounds && speaker; round++) {
    const result = await runMemberTurn(
      threadId,
      team,
      speaker,
      members,
      userInput,
      round === 0,
      workingDir,
      privateMessage,
    );
    const currentId: string = speaker.id;
    privateMessage = undefined;

    // 同一人连续发言上限保护
    sameSpeakerStreak =
      currentId === prevSpeakerId ? sameSpeakerStreak + 1 : 0;
    prevSpeakerId = currentId;
    if (sameSpeakerStreak >= 2) break;

    const nextIdFromControl = controlNextId(result.control);
    if (nextIdFromControl === null) break;

    let nextId: string | null | undefined = nextIdFromControl;
    privateMessage = result.control?.privateMessage;
    if (!nextId) {
      const candidate = selectRandomSpeaker(members, [currentId]);
      nextId = candidate?.id ?? null;
      privateMessage = undefined;
    }

    if (!nextId) break;
    speaker = members.find((m) => m.id === nextId);
  }
}

/**
 * 团队并行模式主流程
 */
async function promptTeamParallel(
  threadId: string,
  userInput: string,
): Promise<void> {
  const thread = useTeamChatStore
    .getState()
    .threads.find((x) => x.id === threadId);
  const team = thread
    ? useTeamsStore.getState().teams.find((t) => t.id === thread.teamId)
    : undefined;
  if (!team) {
    console.error("找不到团队会话对应的团队:", threadId);
    return;
  }

  const allAgents = useConfigStore.getState().agents;
  const members = team.memberIds
    .map((id) => allAgents.find((a) => a.id === id))
    .filter((a): a is AgentConfig => !!a);
  if (members.length === 0) {
    console.error("团队没有可用成员:", team.id);
    return;
  }

  const store = useTeamChatStore.getState();

  // 工作目录：会话级绑定优先，回退团队配置的 workspaceDir；
  // 若仍无，则自动使用团队会话临时目录（自动创建并绑定）。
  let workingDir =
    thread?.workingDir?.trim() || team.workspaceDir?.trim() || undefined;

  if (!workingDir) {
    // 无工作目录时：使用临时目录（团队会话文件目录）作为默认工作目录
    const tempDir = await getTeamSessionFilesDir(threadId);
    await ensureTeamSessionFilesDir(threadId); // 确保目录存在
    workingDir = tempDir;
    // 绑定到当前团队会话
    store.setTeamThreadWorkingDir(threadId, tempDir);
    useTeamMonitorStore.getState().setWorkingDir(threadId, tempDir);
  }

  const userMessage: TeamMessage = {
    id: createId(),
    role: "user",
    content: userInput,
    createdAt: Date.now(),
    status: "complete",
  };
  store.appendMessage(threadId, userMessage);
  await appendTeamUserMessage(threadId, userInput);

  const mentionedIds = parseMentions(userInput, members);
  const speakers =
    mentionedIds.length > 0
      ? mentionedIds
          .map((id) => members.find((member) => member.id === id))
          .filter((member): member is AgentConfig => !!member)
      : members;

  await Promise.allSettled(
    speakers.map((speaker) =>
      runMemberTurn(
        threadId,
        team,
        speaker,
        members,
        userInput,
        true,
        workingDir,
      ),
    ),
  );

  if (speakers.length <= 1) return;

  const reducer =
    members.find((member) => member.id === team.leaderId) ?? members[0];
  await runMemberTurn(
    threadId,
    team,
    reducer,
    members,
    userInput,
    false,
    workingDir,
    "请阅读公开团队讨论，综合所有并行成员的观点。输出最终汇总、关键分歧、推荐方案和下一步；不要再次展开发散。",
  );
}

/**
 * 团队主入口 —— 根据模式路由到不同实现
 */
export async function promptTeam(
  threadId: string,
  userInput: string,
): Promise<void> {
  const store = useTeamChatStore.getState();
  if (store.runningThreadIds.includes(threadId)) {
    return;
  }
  store.markRunning(threadId);

  const thread = useTeamChatStore
    .getState()
    .threads.find((x) => x.id === threadId);
  const team = thread
    ? useTeamsStore.getState().teams.find((t) => t.id === thread.teamId)
    : undefined;

  if (!team) {
    console.error("找不到团队会话对应的团队:", threadId);
    store.stopResponding(threadId);
    return;
  }

  try {
    // 根据模式路由
    if (team.mode === "parallel") {
      await promptTeamParallel(threadId, userInput);
    } else if (team.mode === "equal") {
      await promptTeamEqual(threadId, userInput);
    } else {
      await promptTeamLeader(threadId, userInput);
    }
  } finally {
    useTeamChatStore.getState().stopResponding(threadId);
  }
}

/** 中止某团队会话的所有成员 harness（用户点停止时调用）。 */
export function abortTeamThread(threadId: string): void {
  cancelAskUserRequestsForThread(threadId);
  agentManager.abortThread(threadId);
  useTeamChatStore.getState().stopResponding(threadId);
}

// 供 UI 显示发言成员标签
export { memberLabel };
