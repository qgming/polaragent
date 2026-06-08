// 团队聊天 Store —— 仿 chat-store，但：
//   ① 每条 thread 关联 teamId
//   ② assistant 消息带 speakerAgentId（发言成员）
//   ③ 持久化走「团队会话仓库」（teams/conversations），与普通对话物理隔离

import { useMemo } from "react";
import { create } from "zustand";

import {
  deleteTeamSession,
  getTeamSessionWorkingDir,
  listTeamSessions,
  openOrCreateTeamSession,
  setTeamSessionTeamRef,
  setTeamSessionTitle,
  setTeamSessionWorkingDir,
  ensureTeamSessionFilesDir,
  deleteTeamSessionFilesDir,
} from "@/lib/session/session-operations";
import { loadTeamChatMessages } from "@/lib/session/message-parser";
import { removeTitleIndex, upsertTitleIndex } from "@/lib/session/title-index";
import { generateConversationTitle } from "@/ai/title-generator";
import { useTeamsStore } from "@/stores/team/teams-store";
import type { ChatMessageStatus, ChatRole, Segment } from "@/stores/chat-store";

// 团队消息：在普通消息基础上，assistant 消息携带发言成员 id + 支持投票
export interface TeamMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
  model?: string;
  tokenCount?: number;
  segments?: Segment[];
  // 发言成员的 agentId（assistant 消息）。用户消息无此字段。
  speakerAgentId?: string;
  // 投票相关（通用投票，不限于结束对话）
  vote?: {
    // 投票主题/问题
    topic: string;
    // 发起人 agentId
    initiatorId: string;
    // 投票选项（灵活支持多选项）
    options: Array<{
      id: string;
      label: string; // 例如："同意"、"反对"、"方案A"、"方案B"
    }>;
    // 各成员的投票
    votes: Array<{
      agentId: string;
      optionId: string;
      timestamp: number;
    }>;
    // 成员投票进度。AI 只通过消息正文获取上下文；这里的实时票据用于用户界面展示。
    memberStatuses?: Array<{
      agentId: string;
      status: "pending" | "voting" | "voted" | "failed";
      updatedAt: number;
      error?: string;
    }>;
    // 投票状态
    status: "pending" | "completed" | "cancelled";
    // 投票结果（completed 时）
    result?: {
      topOptionIds: string[]; // 最高票选项；平票时包含多个
      maxVotes: number;
    };
  };
}

export interface TeamThread {
  id: string;
  teamId: string;
  title: string;
  messages: TeamMessage[];
  updatedAt: number;
  loaded?: boolean; // 是否已从磁盘回读过消息
  autoTitled?: boolean; // 是否已基于对话历史自动生成过标题
  // 该会话绑定的工作目录（会话级覆盖；空则回退团队配置的 workspaceDir）
  workingDir?: string;
}

interface TeamChatState {
  threads: TeamThread[];
  // 当前激活的团队会话 id（处于团队聊天页时）
  activeTeamThreadId: string;
  composer: string;
  // 正在后台运行（团队接力中）的会话 id 列表
  runningThreadIds: string[];

  setComposer: (value: string) => void;

  // 会话生命周期
  createTeamThread: (teamId: string) => string;
  selectTeamThread: (threadId: string) => void;
  deleteTeamThread: (threadId: string) => void;
  clearTeamThreadsOfTeam: (teamId: string) => void;
  renameTeamThread: (threadId: string, title: string) => void;
  // 设置某会话的工作目录（内存 + 持久化），并按需从会话回读初始值
  setTeamThreadWorkingDir: (threadId: string, dir: string) => void;
  loadTeamThreadWorkingDir: (threadId: string) => Promise<void>;

  // 消息流式
  appendMessage: (threadId: string, message: TeamMessage) => void;
  applyStreamingUpdate: (
    threadId: string,
    messageId: string,
    update: { appendDelta?: string; segments?: Segment[] },
  ) => void;
  finishMessage: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: { model?: string; tokenCount?: number; segments?: Segment[] },
  ) => void;
  failMessage: (threadId: string, messageId: string, error: string) => void;

  // 消息更新（用于投票实时更新）
  updateMessage: (
    threadId: string,
    messageId: string,
    updates: Partial<TeamMessage>,
  ) => void;

  // 运行态
  markRunning: (threadId: string) => void;
  stopResponding: (threadId: string) => void;

  // 持久化回读
  hydrateTeamThreads: () => Promise<void>;
  loadTeamThreadMessages: (threadId: string) => Promise<void>;
  // 在累计两条「含正文的成员发言」后，基于历史自动生成会话标题（仅一次）
  maybeAutoGenerateTeamTitle: (threadId: string) => Promise<void>;
}

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tmsg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useTeamChatStore = create<TeamChatState>((set, get) => ({
  threads: [],
  activeTeamThreadId: "",
  composer: "",
  runningThreadIds: [],

  setComposer: (value) => set({ composer: value }),

  createTeamThread: (teamId) => {
    const id = `teamthread-${createId()}`;
    const thread: TeamThread = {
      id,
      teamId,
      title: "新会话",
      messages: [],
      updatedAt: Date.now(),
      loaded: true, // 新建会话，内存即权威
    };
    set((state) => ({
      activeTeamThreadId: id,
      composer: "",
      threads: [thread, ...state.threads],
    }));

    // 创建团队会话文件 + 创建文件目录 + 写入归属团队 + 同步标题索引（含 teamId）
    void (async () => {
      await openOrCreateTeamSession(id);
      await ensureTeamSessionFilesDir(id);
      await setTeamSessionTeamRef(id, teamId);
      await upsertTitleIndex(id, "新会话", thread.updatedAt, "team", { teamId });
    })();

    return id;
  },

  selectTeamThread: (threadId) => {
    set({ activeTeamThreadId: threadId, composer: "" });
    void get().loadTeamThreadMessages(threadId);
    void get().loadTeamThreadWorkingDir(threadId);
  },

  deleteTeamThread: (threadId) => {
    set((state) => ({
      activeTeamThreadId:
        state.activeTeamThreadId === threadId ? "" : state.activeTeamThreadId,
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.filter((t) => t.id !== threadId),
    }));
    void deleteTeamSession(threadId);
    // 删除团队会话专属的文件存储目录
    void deleteTeamSessionFilesDir(threadId);
    // 同步从团队标题索引移除
    void removeTitleIndex(threadId, "team");
  },

  // 清空某团队的所有会话（磁盘删除由 session-operations.clearTeamSessions 负责，这里清内存）
	  clearTeamThreadsOfTeam: (teamId) => {
	    set((state) => ({
	      threads: state.threads.filter((t) => t.teamId !== teamId),
	      runningThreadIds: state.runningThreadIds.filter(
	        (id) => state.threads.find((t) => t.id === id)?.teamId !== teamId,
	      ),
	      activeTeamThreadId: state.threads.find(
	        (t) => t.id === state.activeTeamThreadId,
	      )?.teamId === teamId
        ? ""
        : state.activeTeamThreadId,
    }));
  },

  renameTeamThread: (threadId, title) => {
    const next = title.trim();
    if (!next) return;
    const updatedAt = Date.now();
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, title: next, updatedAt } : t,
      ),
    }));
    void setTeamSessionTitle(threadId, next);
    // 同步团队标题索引（teamId 由索引内既有值保留）
    void upsertTitleIndex(threadId, next, updatedAt, "team");
  },

  // 设置某会话工作目录：更新内存 + 持久化到团队会话
  setTeamThreadWorkingDir: (threadId, dir) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, workingDir: dir } : t,
      ),
    }));
    void setTeamSessionWorkingDir(threadId, dir);
  },

  // 从团队会话回读工作目录（仅当内存里尚无时回填）
  loadTeamThreadWorkingDir: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.workingDir) return;
    const dir = await getTeamSessionWorkingDir(threadId);
    if (dir) {
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, workingDir: dir } : t,
        ),
      }));
    }
  },

  appendMessage: (threadId, message) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: [...t.messages, message],
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
  },

  applyStreamingUpdate: (threadId, messageId, update) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content:
                        update.appendDelta !== undefined
                          ? m.content + update.appendDelta
                          : m.content,
                      segments:
                        update.segments !== undefined
                          ? update.segments
                          : m.segments,
                    }
                  : m,
              ),
            }
          : t,
      ),
    }));
  },

  finishMessage: (threadId, messageId, finalContent, metadata) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content: finalContent || m.content,
                      model: metadata?.model ?? m.model,
                      tokenCount: metadata?.tokenCount ?? m.tokenCount,
                      segments: metadata?.segments ?? m.segments,
                      status: "complete" as const,
                    }
                  : m,
              ),
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
  },

  failMessage: (threadId, messageId, error) => {
    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? {
                      ...m,
                      content:
                        m.content || `这次响应没有完成：${error || "请求已中断"}`,
                      status: "error" as const,
                    }
                  : m,
              ),
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
  },

  updateMessage: (threadId, messageId, updates) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId ? { ...m, ...updates } : m,
              ),
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
  },

  markRunning: (threadId) => {
    set((state) => ({
      runningThreadIds: state.runningThreadIds.includes(threadId)
        ? state.runningThreadIds
        : [...state.runningThreadIds, threadId],
    }));
  },

  stopResponding: (threadId) => {
    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
    }));
  },

  // 启动时回读团队会话列表（按 team_ref 归属），消息按需在 select 时加载
  hydrateTeamThreads: async () => {
    const sessions = await listTeamSessions().catch(() => []);
    if (sessions.length === 0) return;

    set((state) => {
      const existingIds = new Set(state.threads.map((t) => t.id));
      const restored: TeamThread[] = sessions
        .filter((s) => !existingIds.has(s.id) && s.teamId)
        .map((s) => ({
          id: s.id,
          teamId: s.teamId as string,
          title: s.title || "新会话",
          messages: [],
          // 优先用索引里的 updatedAt（反映重命名等活动），缺失则回退创建时间
          updatedAt: s.updatedAt ?? (Date.parse(s.createdAt) || 0),
          loaded: false,
          // 已持久化、且标题不是默认「新会话」的，视为已命名，不再自动改名
          autoTitled: !!(s.title && s.title !== "新会话"),
        }));

      const merged = [...state.threads, ...restored].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      return { threads: merged };
    });
  },

  loadTeamThreadMessages: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.loaded) return;

    const messages = await loadTeamChatMessages(threadId);
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: messages.length > 0 ? (messages as TeamMessage[]) : t.messages,
              loaded: true,
            }
          : t,
      ),
    }));
  },

  // 累计两条「含正文的成员发言」后，基于历史自动生成会话标题（仅一次）。
  // 参考普通对话的 maybeAutoGenerateTitle；用团队领导的 provider/model 生成。
  maybeAutoGenerateTeamTitle: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.autoTitled) return;

    // 只取已完成、正文非空的消息（跳过纯工具/思考的空正文）
    const completed = thread.messages.filter(
      (m) => m.status === "complete" && m.content.trim().length > 0,
    );
    // 至少两条「含正文的成员发言」后才生成
    const assistantWithText = completed.filter((m) => m.role === "assistant");
    if (assistantWithText.length < 2) return;

    // 先抢占标记，避免并发/重入重复生成
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, autoTitled: true } : t,
      ),
    }));

    const history = completed.slice(0, 4).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    // 用团队领导的 agentId 调用标题生成；找不到则回退默认
    const team = useTeamsStore
      .getState()
      .teams.find((t) => t.id === thread.teamId);
    const leaderId = team?.leaderId || "default";

    try {
      const title = await generateConversationTitle(history, leaderId);
      if (title) {
        get().renameTeamThread(threadId, title);
      }
    } catch (error) {
      console.error("团队会话自动生成标题失败:", error);
    }
  },
}));

/** 某团队下的会话列表（轻量摘要，按更新时间倒序）。 */
export interface TeamThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}
export function useTeamThreadsOf(teamId: string): TeamThreadSummary[] {
  const signature = useTeamChatStore((state) =>
    JSON.stringify(
      state.threads
        .filter((t) => t.teamId === teamId)
        .map((t) => [t.id, t.title, t.updatedAt]),
    ),
  );
  return useMemo(() => {
    const rows = JSON.parse(signature) as Array<[string, string, number]>;
    return rows
      .map(([id, title, updatedAt]) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [signature]);
}

/** 订阅单个团队会话的消息数组。 */
const EMPTY_TEAM_MESSAGES: TeamMessage[] = [];
export function useTeamThreadMessages(threadId: string): TeamMessage[] {
  return useTeamChatStore(
    (state) =>
      state.threads.find((t) => t.id === threadId)?.messages ??
      EMPTY_TEAM_MESSAGES,
  );
}

/** 订阅某团队会话是否正在运行。 */
export function useIsTeamThreadResponding(threadId: string): boolean {
  return useTeamChatStore((state) =>
    state.runningThreadIds.includes(threadId),
  );
}
