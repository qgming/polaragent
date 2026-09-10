import { useMemo } from "react";
import { create } from "zustand";
import { useConversationStore } from "./conversation-store";
import {
  getSessionWorkingDir,
  getSessionToolPermissionMode,
  setSessionToolPermissionMode,
  setSessionWorkingDir,
  openOrCreateSession,
} from "@/lib/session/personal";
import { generateConversationTitle } from "@/ai/title-generator";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  getLastAssistantUsage,
  shouldCompact,
} from "@/lib/session/compaction";
import {
  BACKGROUND_CONTEXT,
  createBranchSummaryMessage,
  createCompactionSummaryMessage,
  type AgentMessage,
  type Entry,
} from "@earendil-works/pi-agent-core";
import { agentManager } from "@/ai/agent-manager";
import { useConfigStore } from "@/stores/config-store";
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  ChatThread,
  MessageFinishMetadata,
} from "@/lib/chat";
import {
  hasVisibleText,
  partsToPlainText,
  convertLegacyChatMessages,
} from "@/lib/chat";
import {
  DEFAULT_TOOL_PERMISSION_MODE,
  type ToolPermissionMode,
} from "@/types/permissions";

// 切到某对话时从会话 jsonl 恢复工作目录，使重启/切回后仍沿用上次的目录。
async function restoreThreadWorkingDir(threadId: string): Promise<void> {
  if (useChatStore.getState().workingDirs[threadId]) return;
  const dir = await getSessionWorkingDir(threadId);
  if (dir) {
    useChatStore.getState().setThreadWorkingDir(threadId, dir, { persist: false });
  }
}

async function restoreThreadPermissionMode(threadId: string): Promise<void> {
  const mode = await getSessionToolPermissionMode(threadId);
  useChatStore.getState().setThreadPermissionMode(threadId, mode, {
    persist: false,
  });
}

// 应用运行期内已做过"打开时压缩检查"的会话，防止压缩后强制重载造成重入
const compactCheckedThreads = new Set<string>();

// 0.85.0: buildSessionContext 不再从包根导出，这里按官方实现复刻「压缩截断 + 转消息」逻辑，
// 仅用于打开会话时的上下文 token 估算。
// 官方逻辑：保留最后一个 compaction 条目及其后的条目，逐条转成 AgentMessage[]。
function isContextMessage(message: AgentMessage): boolean {
  return (
    message.role !== "assistant" ||
    (message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      message.stopReason !== "deferred")
  );
}

function buildLocalSessionContext(entries: Entry[]): AgentMessage[] {
  // 找最后一个 compaction 条目
  let compactionIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      compactionIndex = i;
      break;
    }
  }
  const kept =
    compactionIndex === -1
      ? [...entries]
      : [entries[compactionIndex], ...entries.slice(compactionIndex + 1)];

  const messages: AgentMessage[] = [];
  for (const entry of kept) {
    if (entry.type === "message") {
      if (isContextMessage(entry.message)) messages.push(entry.message);
    } else if (entry.type === "compaction") {
      messages.push(
        createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
      );
      for (const tail of entry.retainedTail) {
        if (isContextMessage(tail)) messages.push(tail);
      }
    } else if (entry.type === "branch_summary" && entry.summary) {
      messages.push(createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp));
    }
    // custom 条目在无 entryProjectors 时官方逻辑同样跳过
  }
  return messages;
}

// 打开会话时检查是否需要自动压缩上下文
async function checkAndCompactOnOpen(threadId: string): Promise<void> {
  if (compactCheckedThreads.has(threadId)) return;
  compactCheckedThreads.add(threadId);
  // 正在流式响应的会话交给回合末检查（src/ai/agent.ts）处理，
  // 避免压缩与强制重载打断进行中的回复
  if (useChatStore.getState().runningThreadIds.includes(threadId)) return;

  try {
    const session = await openOrCreateSession(threadId);
    const branch = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT);

    // 最后一个 compaction 条目之后若没有新的有效 assistant usage，
    // 说明会话刚被压缩过：旧 usage 反映的是压缩前的上下文，无法可靠估算，
    // 跳过本次检查（下一轮回复产生新 usage 后由回合末检查接管）。
    let lastCompactionIndex = -1;
    for (let i = branch.length - 1; i >= 0; i--) {
      if (branch[i].type === "compaction") {
        lastCompactionIndex = i;
        break;
      }
    }
    if (!getLastAssistantUsage(branch.slice(lastCompactionIndex + 1))) return;

    // 按 compaction 条目截断历史，得到当前真实有效上下文（0.85.0: 本地复刻 buildSessionContext）
    const context = buildLocalSessionContext(branch);
    if (context.length === 0) return;
    const contextTokens = estimateContextTokens(context).tokens;

    // 上下文窗口取当前运行时模型的配置，未配置时保守回退 128k
    const modelId = agentManager.getRuntimeModelId();
    const contextWindow =
      useConfigStore
        .getState()
        .providers?.providers?.flatMap((provider) => provider.models)
        .find((model) => model.id === modelId)?.contextWindow ?? 128000;

    if (!shouldCompact(contextTokens, contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;

    console.log(
      `[压缩] 会话 ${threadId} 打开时触发自动压缩: ${contextTokens} tokens (窗口 ${contextWindow})`,
    );

    try {
      const harness = await agentManager.getOrCreateHarness(threadId);
      const lane = await harness.lane("main", BACKGROUND_CONTEXT);
      await lane.compact(undefined, BACKGROUND_CONTEXT);

      // loadThreadMessages 对已加载会话是 no-op，必须先重置 loaded 再重载
      useChatStore.setState((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, loaded: false } : t,
        ),
      }));
      await useChatStore.getState().loadThreadMessages(threadId);
      console.log(`[压缩] 会话 ${threadId} 压缩完成`);
    } catch (compactError) {
      // "Nothing to compact"：末尾已是压缩条目，属正常情况
      if (
        compactError instanceof Error &&
        compactError.message.includes("Nothing to compact")
      ) {
        return;
      }
      console.warn("[压缩] 执行压缩失败:", compactError);
    }
  } catch (error) {
    console.warn("[压缩] 打开会话时自动压缩失败:", error);
  }
}

export type { ChatAttachment, ChatMessage, ChatMessagePart, ChatThread } from "@/lib/chat";

interface ExchangeStart {
  assistantId: string;
  threadId: string;
}

interface ChatState {
  threads: ChatThread[];
  hydrated: boolean;
  hydrating: boolean;
  activeThreadId: string;
  composer: string;
  // 正在后台运行（响应中）的会话 id 列表。多会话可并行运行、互不关联。
  // 用数组而非 Set，便于 zustand 浅比较与序列化。
  runningThreadIds: string[];
  workingDir: string; // 当前工作目录（新会话默认沿用）
  setWorkingDir: (dir: string) => void;
  // 按会话记录的工作目录（工具执行根目录）；缺失时回退到全局 workingDir
  workingDirs: Record<string, string>;
  setThreadWorkingDir: (
    threadId: string,
    dir: string,
    options?: { persist?: boolean },
  ) => void;
  // 流式合批：用最新有序 parts 整体替换助手消息 content（单次 set，单次重渲染）
  applyStreamingParts: (
    threadId: string,
    messageId: string,
    parts: ChatMessagePart[],
  ) => void;
  clearActiveThread: () => void;
  clearThread: (threadId: string) => void;
  createThread: (
    initialText?: string,
    permissionMode?: ToolPermissionMode,
  ) => string;
  deleteThread: (threadId: string) => void;
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  setRetryAttempt: (threadId: string, messageId: string, attempt: number) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: MessageFinishMetadata,
  ) => void;
  selectThread: (threadId: string) => void;
  showHome: () => void;
  renameThread: (threadId: string, title: string) => void;
  setComposer: (value: string) => void;
  setThreadPermissionMode: (
    threadId: string,
    mode: ToolPermissionMode,
    options?: { persist?: boolean },
  ) => void;
  startExchange: (
    userText: string,
    attachments?: ChatAttachment[],
  ) => ExchangeStart;
  /** 从 messageId 起截断其后消息（不含该条），用于重生成/编辑 */
  truncateFrom: (threadId: string, messageId: string) => void;
  /** 在末尾追加 running 占位助手消息，返回其 id */
  appendAssistantPlaceholder: (threadId: string) => string;
  // 标记某会话为运行中（开始响应时调用）
  markRunning: (threadId: string) => void;
  // 结束某会话的运行态（完成/出错/手动停止时调用）
  stopResponding: (threadId: string) => void;
  saveThreadToFile: (threadId: string) => Promise<void>;
  hydrateThreads: () => Promise<void>;
  loadThreadMessages: (threadId: string) => Promise<void>;
  maybeAutoGenerateTitle: (threadId: string) => Promise<void>;
}

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const titleGenerationInFlight = new Set<string>();

export const useChatStore = create<ChatState>((set, get) => ({
  hydrated: false,
  hydrating: false,
  activeThreadId: "",
  composer: "",
  runningThreadIds: [],
  threads: [],
  workingDir: "",
  workingDirs: {},

  setWorkingDir: (dir) => {
    set({ workingDir: dir });
  },

  setThreadWorkingDir: (threadId, dir, options) => {
    set((state) => {
      const workingDirs = { ...state.workingDirs };
      if (dir.trim()) workingDirs[threadId] = dir;
      else delete workingDirs[threadId];
      return {
        workingDirs,
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, workingDir: dir } : thread,
        ),
      };
    });
    if (options?.persist !== false && dir.trim()) {
      void setSessionWorkingDir(threadId, dir);
    }
  },

  // 流式过程中把最新有序 parts 整体写入助手消息，
  // 让 UI 在生成期间即按思考/工具/正文真实顺序渲染。
  applyStreamingParts: (threadId, messageId, parts) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? { ...message, content: parts }
                  : message,
              ),
            }
          : thread,
      ),
    }));
  },

  clearActiveThread: () => {
    const threadId = get().activeThreadId;
    set((state) => ({
      composer: "",
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: [],
              title: "新对话",
              subtitle: "对话",
              autoTitled: false,
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));
  },

  // 清空指定会话内容：保留会话与其 agent 关联（便于继续与该助手新对话），并同步清空磁盘
  clearThread: (threadId) => {
    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      composer: state.activeThreadId === threadId ? "" : state.composer,
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: [],
              title: "新对话",
              subtitle: "对话",
              autoTitled: false, // 清空后允许重新基于新对话自动命名
              loaded: true, // 内存即权威，避免再从磁盘回读旧消息
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));

    // 同步清空磁盘 JSONL（仅保留 meta 行，agent 关联不变）
    void useConversationStore.getState().clearConversation(threadId);
  },

  createThread: (
    initialText?: string,
    permissionMode = DEFAULT_TOOL_PERMISSION_MODE,
  ) => {
    const id = `thread-${createId()}`;
    const trimmedInitialText = initialText?.trim();
    const userMessage: ChatMessage | null = trimmedInitialText
      ? {
          id: createId(),
          role: "user",
          content: [{ type: "text", text: trimmedInitialText }],
          createdAt: Date.now(),
          status: "complete",
        }
      : null;
    const thread: ChatThread = {
      id,
      // 标题默认「新对话」，等 AI 回复后再由 maybeAutoGenerateTitle 生成替换
      title: "新对话",
      subtitle: "对话",
      messages: userMessage ? [userMessage] : [],
      updatedAt: Date.now(),
      permissionMode,
      loaded: true, // 新建会话，内存即权威，无需从磁盘回读
    };
    set((state) => ({
      activeThreadId: id,
      composer: "",
      threads: [thread, ...state.threads],
    }));

    // 创建会话文件
    void useConversationStore
      .getState()
      .createNewConversation(id, thread.title);
    void setSessionToolPermissionMode(id, thread.permissionMode);
    if (userMessage) {
      void useConversationStore
        .getState()
        .saveMessage(id, userMessage);
    }

    return id;
  },

  deleteThread: (threadId) => {
    set((state) => {
      const threads = state.threads.filter((thread) => thread.id !== threadId);
      const activeThreadId =
        state.activeThreadId === threadId
          ? ""
          : state.activeThreadId;

      return {
        activeThreadId,
        composer: state.activeThreadId === threadId ? "" : state.composer,
        runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
        threads,
      };
    });

    // 清理该线程的运行态
    // 同步删除磁盘上的 JSONL 文件与索引条目，避免重启后重新出现
    void useConversationStore.getState().deleteConversation(threadId);
  },

  failAssistant: (threadId, messageId, error) => {
    let failedMessage: ChatMessage | undefined;

    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? (() => {
              return {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === messageId
                    ? (() => {
                        // content 为空时把完整提示写入 error；有内容时只保留原始错误，不覆盖 content
                        const errorText =
                          !hasVisibleText(message.content)
                            ? `这次响应没有完成：${error || "请求已中断"}`
                            : error || "请求已中断";
                        failedMessage = {
                          ...message,
                          status: "error" as const,
                          metadata: {
                            ...message.metadata,
                            error: errorText,
                            retryAttempt: undefined, // 清除重试状态
                          },
                        };
                        return failedMessage;
                      })()
                    : message,
                ),
                updatedAt: Date.now(),
              };
            })()
          : thread,
      ),
    }));

    // 不再删除整个会话（之前会连用户消息一起丢失）。
    // 只要有 content 或 error 就持久化，保证用户消息与上下文不丢。
    if (
      failedMessage &&
      (hasVisibleText(failedMessage.content) || failedMessage.metadata?.error)
    ) {
      void useConversationStore
        .getState()
        .saveMessage(threadId, failedMessage);
    }
  },

  setRetryAttempt: (threadId, messageId, attempt) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      metadata: {
                        ...message.metadata,
                        retryAttempt: attempt,
                        error: undefined,
                      },
                    }
                  : message,
              ),
            }
          : thread,
      ),
    }));
  },

  finishAssistant: (threadId, messageId, _finalContent, metadata) => {
    let completedMessage: ChatMessage | undefined;

    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? (() => {
              return {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === messageId
                    ? (() => {
                        completedMessage = {
                          ...message,
                          // metadata.content 为最终有序 parts；未提供时保留流式期间已写入的 content
                          content: metadata?.content ?? message.content,
                          status: "complete",
                          metadata: {
                            ...message.metadata,
                            model: metadata?.model ?? message.metadata?.model,
                            tokenCount: metadata?.tokenCount,
                            inputTokens: metadata?.inputTokens,
                            outputTokens: metadata?.outputTokens,
                            cacheReadTokens: metadata?.cacheReadTokens,
                            cacheWriteTokens: metadata?.cacheWriteTokens,
                            contextTokens: metadata?.contextTokens,
                            error: undefined,
                          },
                        };
                        return completedMessage;
                      })()
                    : message,
                ),
                updatedAt: Date.now(),
              };
            })()
          : thread,
      ),
    }));

    if (completedMessage) {
      void useConversationStore
        .getState()
        .saveMessage(threadId, completedMessage);
    }

    // 用户与 AI 各回复两次后（累计 4 条完成消息），基于前 4 条历史自动生成标题
    void get().maybeAutoGenerateTitle(threadId);
  },

  selectThread: (threadId) => {
    set({
      activeThreadId: threadId,
      composer: "",
    });
    // 切换会话时按需从 JSONL 回读历史消息
    void get().loadThreadMessages(threadId);
    // 恢复该会话的工作目录与权限模式
    void restoreThreadWorkingDir(threadId);
    void restoreThreadPermissionMode(threadId);
  },

  showHome: () => {
    set({ activeThreadId: "", composer: "" });
  },

  renameThread: (threadId, title) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;

    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? { ...thread, title: nextTitle, autoTitled: true, updatedAt: Date.now() }
          : thread,
      ),
    }));

    // 同步标题到磁盘索引
    void useConversationStore
      .getState()
      .renameConversation(threadId, nextTitle);
  },

  setComposer: (value) => {
    set({ composer: value });
  },

  setThreadPermissionMode: (threadId, mode, options) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId ? { ...thread, permissionMode: mode } : thread,
      ),
    }));
    if (options?.persist !== false) {
      void setSessionToolPermissionMode(threadId, mode);
    }
    // 同步权限模式到主进程安全中间件（第二道防线）
    window.polaragent.security?.setMode?.(mode);
  },

  startExchange: (userText, attachments = []) => {
    const threadId = get().activeThreadId;
    const assistantId = createId();
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: [{ type: "text", text: userText }],
      createdAt: Date.now(),
      status: "complete",
      attachments,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: [],
      createdAt: Date.now(),
      status: "running",
    };

    // 标题不再用用户首句，保持默认「新对话」，待 AI 回复后自动生成替换。
    // 把该会话标记为运行中（并行运行：其它会话的运行态不受影响）。
    set((state) => ({
      runningThreadIds: state.runningThreadIds.includes(threadId)
        ? state.runningThreadIds
        : [...state.runningThreadIds, threadId],
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              subtitle: "对话",
              messages: [...thread.messages, userMessage, assistantMessage],
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));

    // 保存用户消息
    void useConversationStore
      .getState()
      .saveMessage(threadId, userMessage);

    return { assistantId, threadId };
  },

  truncateFrom: (threadId, messageId) => {
    set((state) => ({
      threads: state.threads.map((thread) => {
        if (thread.id !== threadId) return thread;
        const idx = thread.messages.findIndex((m) => m.id === messageId);
        if (idx < 0) return thread;
        return {
          ...thread,
          messages: thread.messages.slice(0, idx + 1),
          updatedAt: Date.now(),
        };
      }),
    }));
  },

  appendAssistantPlaceholder: (threadId) => {
    const assistantId = createId();
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: [],
      createdAt: Date.now(),
      status: "running",
    };
    set((state) => ({
      runningThreadIds: state.runningThreadIds.includes(threadId)
        ? state.runningThreadIds
        : [...state.runningThreadIds, threadId],
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: [...thread.messages, assistantMessage],
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));
    return assistantId;
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

  saveThreadToFile: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread) return;

    // 保存所有完成的消息
    for (const message of thread.messages) {
      if (message.status === "complete") {
        try {
          await useConversationStore
            .getState()
            .saveMessage(threadId, message);
        } catch (error) {
          console.error("保存消息失败:", error);
        }
      }
    }
  },

  // 启动时从磁盘索引回读会话列表，填充侧边栏（消息按需在 selectThread 时加载）
  hydrateThreads: async () => {
    if (get().hydrating || get().hydrated) return;
    set({ hydrating: true });
    const convStore = useConversationStore.getState();
    try {
      await convStore.loadConversations();

      const metas = useConversationStore.getState().conversations;
      if (metas.length === 0) {
        set({ hydrated: true, hydrating: false });
        return;
      }

      set((state) => {
        const existingIds = new Set(state.threads.map((t) => t.id));
        const restored: ChatThread[] = metas
          .filter((meta) => !existingIds.has(meta.id))
          .map((meta) => ({
            id: meta.id,
            title: meta.title || "新对话",
            subtitle: "对话",
            messages: [], // 占位，进入会话时再从 JSONL 回读
            updatedAt: meta.updatedAt,
            permissionMode: DEFAULT_TOOL_PERMISSION_MODE,
            loaded: false,
            autoTitled: true, // 已持久化的会话沿用其标题，不再自动改名
          }));

        // 合并后按更新时间倒序，确保侧边栏顺序稳定
        const merged = [...state.threads, ...restored].sort(
          (a, b) => b.updatedAt - a.updatedAt,
        );
        return { threads: merged, hydrated: true, hydrating: false };
      });
    } catch (error) {
      set({ hydrated: true, hydrating: false });
      throw error;
    }
  },

  // 按需从 JSONL 回读某会话的历史消息（仅在首次进入时加载，避免覆盖内存中的最新状态）
  loadThreadMessages: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.loaded) return;

    const rawMessages = await useConversationStore
      .getState()
      .loadConversation(threadId);

    // 旧格式（string content + segments）一次性转为 parts；新格式原样保留
    const messages = convertLegacyChatMessages(rawMessages as unknown[]);

    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              messages: messages.length > 0 ? messages : t.messages,
              loaded: true,
            }
          : t,
      ),
    }));

    // 异步检查是否需要自动压缩（不阻塞 UI）
    void checkAndCompactOnOpen(threadId);
  },

  // AI 首次产出正文后，基于「用户问题 + AI 正文」生成真实对话标题（仅一次）
  maybeAutoGenerateTitle: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.autoTitled) return;
    if (thread.title.trim() !== "新对话") {
      set((state) => ({
        threads: state.threads.map((t) =>
          t.id === threadId ? { ...t, autoTitled: true } : t,
        ),
      }));
      return;
    }
    if (titleGenerationInFlight.has(threadId)) return;

    // 只取已完成、且「正文非空」的消息：跳过纯工具调用/思考的空正文 AI 消息
    const completed = thread.messages.filter(
      (message) =>
        message.status === "complete" && hasVisibleText(message.content),
    );

    // 至少要有一条「含正文」的 AI 回复后才生成
    const assistantWithText = completed.filter(
      (message) => message.role === "assistant",
    );
    if (assistantWithText.length < 1) return;

    // 用 in-flight 去重，避免并发/重入重复生成；失败时不锁死，后续消息完成可重试。
    titleGenerationInFlight.add(threadId);

    // 用户问题 + AI 正文一起作为生成依据（取前若干条，控制 token）
    const history = completed.slice(0, 4).map((message) => ({
      role: message.role,
      content: partsToPlainText(message.content),
    }));

    try {
      const title = await generateConversationTitle(history);
      if (title) {
        // renameThread 会同步内存标题并写入磁盘索引
        get().renameThread(threadId, title);
      }
    } catch (error) {
      console.error("自动生成标题失败:", error);
    } finally {
      titleGenerationInFlight.delete(threadId);
    }
  },
}));

/** 订阅某会话是否正在运行（响应中）。多会话可并行运行、互不关联。 */
export function useIsThreadResponding(threadId: string): boolean {
  return useChatStore((state) => state.runningThreadIds.includes(threadId));
}

/** 会话列表的轻量摘要（仅 id/title/updatedAt，按更新时间倒序）。
 *  侧边栏只需这些字段——避免订阅整个 threads，否则任一会话吐 token 都会
 *  让侧边栏（乃至整个 App）随之重渲染。useShallow 做浅比较，内容不变则不触发。 */
export interface ThreadSummary {
  id: string;
  title: string;
  updatedAt: number;
}
// 用 JSON 签名做按值比较：仅当 id/title/updatedAt 真正变化时才返回新引用。
// 不能直接用 useShallow——它对数组逐元素做 Object.is，每次 .map() 都产生全新对象，
// 永远判不等，会让 useSyncExternalStore 无限循环导致白屏。
export function useThreadSummaries(): ThreadSummary[] {
  const signature = useChatStore((state) =>
    JSON.stringify(state.threads.map((t) => [t.id, t.title, t.updatedAt])),
  );
  return useMemo(() => {
    const rows = JSON.parse(signature) as Array<[string, string, number]>;
    return rows
      .map(([id, title, updatedAt]) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [signature]);
}

/** 订阅单个会话的消息数组。该数组仅在「这个会话」变化时才换引用，
 *  其它会话后台流式更新不会触发本会话的重渲染。 */
export function useThreadMessages(threadId: string): ChatMessage[] {
  return useChatStore(
    (state) => state.threads.find((t) => t.id === threadId)?.messages ?? EMPTY_MESSAGES,
  );
}

/** 订阅单个会话的标题（标量，引用稳定）。 */
export function useThreadTitle(threadId: string): string {
  return useChatStore(
    (state) => state.threads.find((t) => t.id === threadId)?.title ?? "新对话",
  );
}

export function useThreadPermissionMode(threadId: string): ToolPermissionMode {
  return useChatStore(
    (state) =>
      state.threads.find((t) => t.id === threadId)?.permissionMode ??
      DEFAULT_TOOL_PERMISSION_MODE,
  );
}

/** 订阅单个会话的工作目录；缺失时回退到全局 workingDir。 */
export function useThreadWorkingDir(threadId: string): string {
  return useChatStore(
    (state) =>
      state.threads.find((t) => t.id === threadId)?.workingDir ??
      state.workingDir ??
      "",
  );
}

// 稳定的空消息数组，避免每次返回新 [] 触发重渲染
const EMPTY_MESSAGES: ChatMessage[] = [];
