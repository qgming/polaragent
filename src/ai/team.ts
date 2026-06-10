// 团队运行时 —— 支持领导模式与头脑风暴模式
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
} from "@/lib/session/team";
import { useConfigStore } from "@/stores/config-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import {
  useTeamChatStore,
} from "@/stores/team/team-chat-store";
import { useTeamMonitorStore } from "@/stores/team/team-monitor-store";
import type { ChatAttachment } from "@/lib/chat";
import {
  buildIdentityPrefix,
  buildTranscript,
  memberLabel,
  memberSessionId,
  pickMentionedSpeaker,
  selectRandomSpeaker,
  serializeUserInputWithAttachments,
  textAttachmentPaths,
  type TeamMessage,
  type TeamThread,
} from "@/lib/team";
import type { AgentConfig, TeamConfig } from "@/types/config";
import { DEFAULT_TOOL_PERMISSION_MODE } from "@/types/permissions";

type TeamRunContext = {
  thread: TeamThread;
  team: TeamConfig;
  members: AgentConfig[];
};

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tmsg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
  attachments?: ChatAttachment[],
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
  const transcript = buildTranscript(
    useTeamChatStore.getState().threads.find((t) => t.id === threadId)?.messages ?? [],
    members,
  );
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
  const knowledgeBaseIds =
    useTeamChatStore.getState().threads.find((t) => t.id === threadId)
      ?.knowledgeBaseIds ?? [];

  const teamContext: TeamContext = {
    isTeam: true,
    extraSkillIds: team.enabledSkills ?? [],
    teamSystemPrompt: team.systemPrompt ?? "",
    identityPrefix: buildIdentityPrefix(team, speaker, members),
    sessionId: memberSessionId(threadId, speaker.id),
    teamConfig: team,
    currentAgentId: speaker.id,
    members,
    knowledgeBaseIds,
  };

  let finalContent = "";

  await new Promise<void>((resolve) => {
    const permissionMode =
      useTeamChatStore
        .getState()
        .threads.find((item) => item.id === threadId)?.permissionMode ??
      DEFAULT_TOOL_PERMISSION_MODE;
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
        filePaths: textAttachmentPaths(attachments),
        attachments,
        permissionMode,
        knowledgeBaseIds,
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

function resolveTeamRunContext(threadId: string): TeamRunContext | null {
  const thread = useTeamChatStore
    .getState()
    .threads.find((x) => x.id === threadId);
  const team = thread
    ? useTeamsStore.getState().teams.find((t) => t.id === thread.teamId)
    : undefined;
  if (!team || !thread) {
    console.error("找不到团队会话对应的团队:", threadId);
    return null;
  }

  const allAgents = useConfigStore.getState().agents;
  const members = team.memberIds
    .map((id) => allAgents.find((agent) => agent.id === id))
    .filter((agent): agent is AgentConfig => !!agent);
  if (members.length === 0) {
    console.error("团队没有可用成员:", team.id);
    return null;
  }

  return { thread, team, members };
}

async function resolveTeamWorkingDir(
  threadId: string,
  thread: TeamRunContext["thread"],
  team: TeamConfig,
): Promise<string> {
  const existing = thread.workingDir?.trim() || team.workspaceDir?.trim();
  if (existing) return existing;

  const tempDir = await getTeamSessionFilesDir(threadId);
  await ensureTeamSessionFilesDir(threadId);
  useTeamChatStore.getState().setTeamThreadWorkingDir(threadId, tempDir);
  useTeamMonitorStore.getState().setWorkingDir(threadId, tempDir);
  return tempDir;
}

async function appendTeamUserInput(
  threadId: string,
  userInput: string,
  attachments: ChatAttachment[],
): Promise<void> {
  const userMessage: TeamMessage = {
    id: createId(),
    role: "user",
    content: userInput,
    createdAt: Date.now(),
    status: "complete",
    attachments,
  };
  useTeamChatStore.getState().appendMessage(threadId, userMessage);
  await appendTeamUserMessage(
    threadId,
    serializeUserInputWithAttachments(userInput, attachments),
  );
}

/**
 * 团队领导模式主流程。userInput 为用户本轮输入（含可能的 @成员）。
 */
async function promptTeamLeader(
  threadId: string,
  userInput: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const context = resolveTeamRunContext(threadId);
  if (!context) return;
  const { thread, team, members } = context;
  const workingDir = await resolveTeamWorkingDir(threadId, thread, team);
  await appendTeamUserInput(threadId, userInput, attachments);

  // 首个发言者：用户 @ 指定 > 领导
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
      round === 0 ? attachments : undefined,
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
 * 团队头脑风暴模式主流程
 */
async function promptTeamEqual(
  threadId: string,
  userInput: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const context = resolveTeamRunContext(threadId);
  if (!context) return;
  const { thread, team, members } = context;
  const workingDir = await resolveTeamWorkingDir(threadId, thread, team);
  await appendTeamUserInput(threadId, userInput, attachments);

  // 首个发言者：用户 @ 指定 > 随机选择
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
      round === 0 ? attachments : undefined,
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
 * 团队主入口 —— 根据模式路由到不同实现
 */
export async function promptTeam(
  threadId: string,
  userInput: string,
  attachments: ChatAttachment[] = [],
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
    if (team.mode === "equal") {
      await promptTeamEqual(threadId, userInput, attachments);
    } else {
      await promptTeamLeader(threadId, userInput, attachments);
    }
  } finally {
    useTeamChatStore.getState().stopResponding(threadId);
  }
}

/**
 * 团队运行中插入用户引导：写入团队公共会话，并尝试投递给当前正在运行的成员 harness。
 * 即使当前成员刚好结束、steer 未命中，后续成员也能通过团队讨论转写读取到这条引导。
 */
export async function steerTeamThread(
  threadId: string,
  text: string,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const accepted = await agentManager.steerThread(threadId, trimmed);
  if (accepted === 0) return false;

  await appendTeamUserMessage(threadId, trimmed);
  return true;
}

/** 中止某团队会话的所有成员 harness（用户点停止时调用）。 */
export function abortTeamThread(threadId: string): void {
  cancelAskUserRequestsForThread(threadId);
  agentManager.abortThread(threadId);
  useTeamChatStore.getState().stopResponding(threadId);
}

// 供 UI 显示发言成员标签
export { memberLabel };
