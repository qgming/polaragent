import { useMemo } from "react";
import { create } from "zustand";
import { useConversationStore } from "./conversation-store";
import { useTaskMonitorStore } from "./task-monitor-store";
import { getSessionWorkingDir } from "@/lib/session/session-operations";
import { loadThreadMonitor } from "@/lib/session/message-parser";
import { generateConversationTitle } from "@/ai/title-generator";

// 切到某对话时从会话 jsonl 恢复右侧任务监控（工作目录 + 待办 + 产物），
// 使重启/切回后侧边栏与上次保持一致。仅在运行期尚无对应数据时回填，不覆盖。
async function restoreThreadMonitor(threadId: string): Promise<void> {
  // 工作目录：仅当任务监控里尚无该线程的工作目录时回填
  const existing = useTaskMonitorStore.getState().getMonitor(threadId).workingDir;
  if (!existing) {
    const dir = await getSessionWorkingDir(threadId);
    if (dir) {
      useTaskMonitorStore.getState().setWorkingDir(threadId, dir);
    }
  }
  // 待办 + 产物：从 jsonl 回读重建后灌入（hydrateThread 内部会跳过已有数据的会话）
  const snapshot = await loadThreadMonitor(threadId);
  useTaskMonitorStore.getState().hydrateThread(threadId, snapshot);
}

export type ChatRole = "assistant" | "user";

export type ChatMessageStatus = "complete" | "streaming" | "error";

export interface ChatAttachment {
  path: string;
  name: string;
  kind: "text" | "image";
}

// 助手消息的「有序段」——复用 pi 的 AssistantMessage.content block 顺序。
// text：正文（渲染成 markdown）；thinking：深度思考；tool：工具调用。
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "guidance"; text: string; createdAt: number }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      label: string;
      status: "running" | "done" | "error";
      // 工具调用的完整结果文本，供步骤项点击展开查看（无则不展示展开）
      resultText?: string;
      // 仅 update_todos：该次调用写入的完整待办快照，用于把后续段按待办分组折叠
      todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
    };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
  model?: string;
  tokenCount?: number;
  attachments?: ChatAttachment[];
  // 助手消息的过程结构（思考/工具/正文有序）。用户消息无此字段。
  segments?: Segment[];
}

export interface ChatThread {
  id: string;
  title: string;
  subtitle: string;
  messages: ChatMessage[];
  updatedAt: number;
  agentId?: string; // 关联的 Agent ID
  loaded?: boolean; // 是否已从磁盘 JSONL 回读过消息
  autoTitled?: boolean; // 是否已基于对话历史自动生成过标题
}

interface ExchangeStart {
  assistantId: string;
  threadId: string;
}

interface ChatState {
  threads: ChatThread[];
  activeThreadId: string;
  composer: string;
  // 正在后台运行（响应中）的会话 id 列表。多会话可并行运行、互不关联。
  // 用数组而非 Set，便于 zustand 浅比较与序列化。
  runningThreadIds: string[];
  activeAgentId: string; // 当前使用的 Agent
  workingDir: string; // 当前工作目录（新会话默认沿用）
  setWorkingDir: (dir: string) => void;
  appendAssistantDelta: (
    threadId: string,
    messageId: string,
    delta: string,
  ) => void;
  // 流式过程中实时更新助手消息的有序段（思考/工具/正文按真实顺序）
  updateAssistantSegments: (
    threadId: string,
    messageId: string,
    segments: Segment[],
  ) => void;
  // 流式合批：一次性追加文本增量 + 替换 segments（单次 set，单次重渲染）
  applyStreamingUpdate: (
    threadId: string,
    messageId: string,
    update: { appendDelta?: string; segments?: Segment[] },
  ) => void;
  clearActiveThread: () => void;
  clearThread: (threadId: string) => void;
  createThread: (agentId?: string, initialText?: string) => string;
  deleteThread: (threadId: string) => void;
  failAssistant: (threadId: string, messageId: string, error: string) => void;
  finishAssistant: (
    threadId: string,
    messageId: string,
    finalContent: string,
    metadata?: { model?: string; tokenCount?: number; segments?: Segment[] },
  ) => void;
  selectThread: (threadId: string) => void;
  showHome: () => void;
  renameThread: (threadId: string, title: string) => void;
  setComposer: (value: string) => void;
  startExchange: (userText: string, attachments?: ChatAttachment[]) => ExchangeStart;
  // 标记某会话为运行中（开始响应时调用）
  markRunning: (threadId: string) => void;
  // 结束某会话的运行态（完成/出错/手动停止时调用）
  stopResponding: (threadId: string) => void;
  setActiveAgent: (agentId: string) => void;
  saveThreadToFile: (threadId: string) => Promise<void>;
  hydrateThreads: () => Promise<void>;
  loadThreadMessages: (threadId: string) => Promise<void>;
  maybeAutoGenerateTitle: (threadId: string) => Promise<void>;
}

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useChatStore = create<ChatState>((set, get) => ({
  activeThreadId: "",
  composer: "",
  runningThreadIds: [],
  threads: [],
  activeAgentId: "default", // 默认 Agent
  workingDir: "",

  setWorkingDir: (dir) => {
    set({ workingDir: dir });
  },

  appendAssistantDelta: (threadId, messageId, delta) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? { ...message, content: message.content + delta }
                  : message,
              ),
              updatedAt: Date.now(),
            }
          : thread,
      ),
    }));
  },

  // 流式过程中实时把当前已聚合的有序段写入助手消息，
  // 让 UI 在生成期间即按思考/工具/正文真实顺序渲染（而非等结束才补）。
  updateAssistantSegments: (threadId, messageId, segments) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? { ...message, segments }
                  : message,
              ),
            }
          : thread,
      ),
    }));
  },

  // 流式合批：一次性追加文本增量 + 替换 segments，合并为单次 set（单次重渲染）。
  applyStreamingUpdate: (threadId, messageId, update) => {
    set((state) => ({
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? {
              ...thread,
              messages: thread.messages.map((message) =>
                message.id === messageId
                  ? {
                      ...message,
                      content:
                        update.appendDelta !== undefined
                          ? message.content + update.appendDelta
                          : message.content,
                      segments:
                        update.segments !== undefined
                          ? update.segments
                          : message.segments,
                    }
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

  createThread: (agentId?: string, initialText?: string) => {
    const id = `thread-${createId()}`;
    const trimmedInitialText = initialText?.trim();
    const userMessage: ChatMessage | null = trimmedInitialText
      ? {
          id: createId(),
          role: "user",
          content: trimmedInitialText,
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
      agentId: agentId || get().activeAgentId, // 关联当前 Agent
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
      .createNewConversation(id, thread.title, agentId || get().activeAgentId);

    if (userMessage) {
      void useConversationStore
        .getState()
        .saveMessage(id, userMessage, agentId || get().activeAgentId);
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

    // 同步删除磁盘上的 JSONL 文件与索引条目，避免重启后重新出现
    void useConversationStore.getState().deleteConversation(threadId);
  },

  failAssistant: (threadId, messageId, error) => {
    let failedMessage: ChatMessage | undefined;
    let failedAgentId = "default";

    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? (() => {
              failedAgentId = thread.agentId || "default";
              return {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === messageId
                    ? (() => {
                        failedMessage = {
                          ...message,
                          content:
                            message.content ||
                            `这次响应没有完成：${error || "请求已中断"}`,
                          status: "error" as const,
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
    // 若助手已产出部分内容，则持久化为出错消息，保证用户消息与上下文不丢。
    if (failedMessage && failedMessage.content.trim().length > 0) {
      void useConversationStore
        .getState()
        .saveMessage(threadId, failedMessage, failedAgentId);
    }
  },

  finishAssistant: (threadId, messageId, finalContent, metadata) => {
    let completedMessage: ChatMessage | undefined;
    let completedAgentId = "default";

    set((state) => ({
      runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
      threads: state.threads.map((thread) =>
        thread.id === threadId
          ? (() => {
              completedAgentId = thread.agentId || "default";
              return {
                ...thread,
                messages: thread.messages.map((message) =>
                  message.id === messageId
                    ? (() => {
                        completedMessage = {
                          ...message,
                          content: finalContent || message.content,
                          model: metadata?.model ?? message.model,
                          status: "complete",
                          tokenCount: metadata?.tokenCount,
                          segments: metadata?.segments ?? message.segments,
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
        .saveMessage(threadId, completedMessage, completedAgentId);
    }

    // 用户与 AI 各回复两次后（累计 4 条完成消息），基于前 4 条历史自动生成标题
    void get().maybeAutoGenerateTitle(threadId);
  },

  selectThread: (threadId) => {
    set({ activeThreadId: threadId, composer: "" });
    // 切换会话时按需从 JSONL 回读历史消息
    void get().loadThreadMessages(threadId);
    // 从会话 jsonl 恢复该对话的任务监控（工作目录 + 待办 + 产物）
    void restoreThreadMonitor(threadId);
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
          ? { ...thread, title: nextTitle, updatedAt: Date.now() }
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

  startExchange: (userText, attachments = []) => {
    const threadId = get().activeThreadId;
    const assistantId = createId();
    const userMessage: ChatMessage = {
      id: createId(),
      role: "user",
      content: userText,
      createdAt: Date.now(),
      status: "complete",
      attachments,
    };
    const assistantMessage: ChatMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: Date.now(),
      status: "streaming",
      model: "polar-dialogue-1",
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
    const thread = get().threads.find((t) => t.id === threadId);
    if (thread) {
      void useConversationStore
        .getState()
        .saveMessage(threadId, userMessage, thread.agentId || "default");
    }

    return { assistantId, threadId };
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

  setActiveAgent: (agentId: string) => {
    set({ activeAgentId: agentId });
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
            .saveMessage(threadId, message, thread.agentId || "default");
        } catch (error) {
          console.error("保存消息失败:", error);
        }
      }
    }
  },

  // 启动时从磁盘索引回读会话列表，填充侧边栏（消息按需在 selectThread 时加载）
  hydrateThreads: async () => {
    const convStore = useConversationStore.getState();
    await convStore.loadConversations();

    const metas = useConversationStore.getState().conversations;
    if (metas.length === 0) return;

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
          loaded: false,
          autoTitled: true, // 已持久化的会话沿用其标题，不再自动改名
        }));

      // 合并后按更新时间倒序，确保侧边栏顺序稳定
      const merged = [...state.threads, ...restored].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      return { threads: merged };
    });
  },

  // 按需从 JSONL 回读某会话的历史消息（仅在首次进入时加载，避免覆盖内存中的最新状态）
  loadThreadMessages: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.loaded) return;

    const messages = await useConversationStore
      .getState()
      .loadConversation(threadId);

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
  },

  // AI 首次产出正文后，基于「用户问题 + AI 正文」生成真实对话标题（仅一次）
  maybeAutoGenerateTitle: async (threadId: string) => {
    const thread = get().threads.find((t) => t.id === threadId);
    if (!thread || thread.autoTitled) return;

    // 只取已完成、且「正文非空」的消息：跳过纯工具调用/思考的空正文 AI 消息
    const completed = thread.messages.filter(
      (message) =>
        message.status === "complete" && message.content.trim().length > 0,
    );

    // 至少要有一条「含正文」的 AI 回复后才生成
    const assistantWithText = completed.filter(
      (message) => message.role === "assistant",
    );
    if (assistantWithText.length < 1) return;

    // 先抢占标记，避免并发/重入导致重复生成
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId ? { ...t, autoTitled: true } : t,
      ),
    }));

    // 用户问题 + AI 正文一起作为生成依据（取前若干条，控制 token）
    const history = completed.slice(0, 4).map((message) => ({
      role: message.role,
      content: message.content,
    }));

    try {
      const title = await generateConversationTitle(
        history,
        thread.agentId || "default",
      );
      if (title) {
        // renameThread 会同步内存标题并写入磁盘索引
        get().renameThread(threadId, title);
      }
    } catch (error) {
      console.error("自动生成标题失败:", error);
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

/** 订阅单个会话关联的 agentId（标量）。 */
export function useThreadAgentId(threadId: string): string | undefined {
  return useChatStore(
    (state) => state.threads.find((t) => t.id === threadId)?.agentId,
  );
}

// 稳定的空消息数组，避免每次返回新 [] 触发重渲染
const EMPTY_MESSAGES: ChatMessage[] = [];
