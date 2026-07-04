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
  getTeamSessionToolPermissionMode,
  setTeamSessionToolPermissionMode,
  getTeamSessionKnowledgeBaseIds,
  setTeamSessionKnowledgeBaseIds,
} from "@/lib/session/team";
import { loadTeamChatMessages } from "@/lib/session/message-parser";
import { removeTitleIndex, upsertTitleIndex } from "@/lib/session/title-index";
import { generateConversationTitle } from "@/ai/title-generator";
import { clearThreadCaptureTokens } from "@/ai/memory-capture";
import type { MessageFinishMetadata, Segment } from "@/lib/chat";
import type { TeamMessage, TeamThread } from "@/lib/team";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";

export type { TeamMessage, TeamThread } from "@/lib/team";

interface TeamChatState {
  threads: TeamThread[];
  hydrated: boolean;
  hydrating: boolean;
  // 当前激活的团队会话 id（处于团队聊天页时）
  activeTeamThreadId: string;
  composer: string;
  // 正在后台运行（团队接力中）的会话 id 列表
  runningThreadIds: string[];

  setComposer: (value: string) => void;

  // 会话生命周期
  createTeamThread: (
    teamId: string,
    permissionMode?: ToolPermissionMode,
  ) => string;
  selectTeamThread: (threadId: string) => void;
  deleteTeamThread: (threadId: string) => void;
  clearTeamThreadsOfTeam: (teamId: string) => void;
  renameTeamThread: (threadId: string, title: string) => void;
  // 设置某会话的工作目录（内存 + 持久化），并按需从会话回读初始值
  setTeamThreadWorkingDir: (threadId: string, dir: string) => void;
  loadTeamThreadWorkingDir: (threadId: string) => Promise<void>;
  setTeamThreadPermissionMode: (threadId: string, mode: ToolPermissionMode) => void;
  loadTeamThreadPermissionMode: (threadId: string) => Promise<void>;
  setThreadKnowledgeBaseIds: (threadId: string, ids: string[]) => void;
  loadTeamThreadKnowledgeBaseIds: (threadId: string) => Promise<void>;

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
    metadata?: MessageFinishMetadata,
  ) => void;
  failMessage: (threadId: string, messageId: string, error: string) => void;
  setRetryAttempt: (threadId: string, messageId: string, attempt: number) => void;

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

const teamTitleGenerationInFlight = new Set<string>();

export const useTeamChatStore = create<TeamChatState>((set, get) => ({
  threads: [],
  hydrated: false,
  hydrating: false,
  activeTeamThreadId: "",
  composer: "",
  runningThreadIds: [],

  setComposer: (value) => set({ composer: value }),

  createTeamThread: (
    teamId,
    permissionMode = DEFAULT_TOOL_PERMISSION_MODE,
  ) => {
    const id = `teamthread-${createId()}`;
    const thread: TeamThread = {
      id,
      teamId,
      title: "新会话",
      messages: [],
      updatedAt: Date.now(),
      loaded: true, // 新建会话，内存即权威
      permissionMode,
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
      await setTeamSessionToolPermissionMode(id, thread.permissionMode);
      await upsertTitleIndex(id, "新会话", thread.updatedAt, "team", { teamId });
    })();

    return id;
  },

  selectTeamThread: (threadId) => {
    set({ activeTeamThreadId: threadId, composer: "" });
    void get().loadTeamThreadMessages(threadId);
    void get().loadTeamThreadWorkingDir(threadId);
    void get().loadTeamThreadPermissionMode(threadId);
    void get().loadTeamThreadKnowledgeBaseIds(threadId);
  },

  deleteTeamThread: (threadId) => {
    set((state) => ({
      activeTeamThreadId:
        state.activeTeamThreadId === threadId ? "" : state.activeTeamThreadId,
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.filter((t) => t.id !== threadId),
    }));
    // 清理该线程的自动记忆捕获 token 标记
    clearThreadCaptureTokens(threadId);
    void deleteTeamSession(threadId);
    // 删除团队会话专属的文件存储目录
    void deleteTeamSessionFilesDir(threadId);
    // 同步从团队标题索引移除
    void removeTitleIndex(threadId, "team");
  },

  // 清空某团队的所有会话（磁盘删除由 team session facade 负责，这里清内存）
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
        t.id === threadId ? { ...t, title: next, autoTitled: true, updatedAt } : t,
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

  setTeamThreadPermissionMode: (threadId, mode) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, permissionMode: mode } : t,
      ),
    }));
    void setTeamSessionToolPermissionMode(threadId, mode);
    // 同步权限模式到主进程安全中间件
    window.polaragent.security?.setMode?.(mode);
  },

  loadTeamThreadPermissionMode: async (threadId) => {
    const mode = await getTeamSessionToolPermissionMode(threadId);
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, permissionMode: mode } : t,
      ),
    }));
  },

  setThreadKnowledgeBaseIds: (threadId, ids) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, knowledgeBaseIds: ids } : t,
      ),
    }));
    void setTeamSessionKnowledgeBaseIds(threadId, ids);
  },

  loadTeamThreadKnowledgeBaseIds: async (threadId) => {
    const ids = await getTeamSessionKnowledgeBaseIds(threadId);
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, knowledgeBaseIds: ids } : t,
      ),
    }));
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
                      inputTokens: metadata?.inputTokens ?? m.inputTokens,
                      outputTokens: metadata?.outputTokens ?? m.outputTokens,
                      cacheReadTokens: metadata?.cacheReadTokens ?? m.cacheReadTokens,
                      cacheWriteTokens: metadata?.cacheWriteTokens ?? m.cacheWriteTokens,
                      contextTokens: metadata?.contextTokens ?? m.contextTokens,
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
                      // content 为空时把完整提示写入 error；有内容时只保留原始错误，不覆盖 content
                      error:
                        m.content.trim().length === 0
                          ? `这次响应没有完成：${error || "请求已中断"}`
                          : error || "请求已中断",
                      status: "error" as const,
                      retryAttempt: undefined, // 清除重试状态
                    }
                  : m,
              ),
              updatedAt: Date.now(),
            }
          : t,
      ),
    }));
  },

  setRetryAttempt: (threadId, messageId, attempt) => {
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: t.messages.map((m) =>
                m.id === messageId
                  ? { ...m, retryAttempt: attempt, error: undefined }
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
    if (get().hydrating || get().hydrated) return;
    set({ hydrating: true });
    const sessions = await listTeamSessions().catch(() => []);
    if (sessions.length === 0) {
      set({ hydrated: true, hydrating: false });
      return;
    }

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
          permissionMode: DEFAULT_TOOL_PERMISSION_MODE,
          loaded: false,
          // 已持久化、且标题不是默认「新会话」的，视为已命名，不再自动改名
          autoTitled: !!(s.title && s.title !== "新会话"),
        }));

      const merged = [...state.threads, ...restored].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      return { threads: merged, hydrated: true, hydrating: false };
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
  // 标题生成统一走模型设置里的默认路由模型，不跟随某个团队成员的锁定模型。
  maybeAutoGenerateTeamTitle: async (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.autoTitled) return;
    if (thread.title.trim() !== "新会话") {
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, autoTitled: true } : t,
        ),
      }));
      return;
    }
    if (teamTitleGenerationInFlight.has(threadId)) return;

    // 只取已完成、正文非空的消息（跳过纯工具/思考的空正文）
    const completed = thread.messages.filter(
      (m) => m.status === "complete" && m.content.trim().length > 0,
    );
    // 至少两条「含正文的成员发言」后才生成
    const assistantWithText = completed.filter((m) => m.role === "assistant");
    if (assistantWithText.length < 2) return;

    // 用 in-flight 去重，避免并发/重入重复生成；失败时不锁死，后续消息完成可重试。
    teamTitleGenerationInFlight.add(threadId);

    const history = completed.slice(0, 4).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    try {
      const title = await generateConversationTitle(history);
      if (title) {
        get().renameTeamThread(threadId, title);
      }
    } catch (error) {
      console.error("团队会话自动生成标题失败:", error);
    } finally {
      teamTitleGenerationInFlight.delete(threadId);
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

export function useTeamThreadPermissionMode(threadId: string): ToolPermissionMode {
  return useTeamChatStore(
    (state) =>
      state.threads.find((t) => t.id === threadId)?.permissionMode ??
      DEFAULT_TOOL_PERMISSION_MODE,
  );
}

export function useTeamThreadKnowledgeBaseIds(threadId: string): string[] {
  return useTeamChatStore(
    (state) =>
      state.threads.find((t) => t.id === threadId)?.knowledgeBaseIds ??
      EMPTY_TEAM_KNOWLEDGE_BASE_IDS,
  );
}

const EMPTY_TEAM_KNOWLEDGE_BASE_IDS: string[] = [];
