import { create } from "zustand";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  ChatMessage,
  QueuedMessage,
  SessionSummary,
} from "@/shared/contracts";

/** 单页加载的消息条数 */
const PAGE_SIZE = 40;

interface ChatState {
  /** 会话列表（按 updatedAt 降序） */
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** 各会话的消息列表（时间升序） */
  messagesBySession: Record<string, ChatMessage[]>;
  /** 各会话的向上翻页游标 */
  pageCursorBySession: Record<string, number | undefined>;
  /** 各会话是否还有更早消息 */
  hasMoreBySession: Record<string, boolean>;
  /** 各会话是否正在向上翻页取更早消息（并发闸门 + 顶部加载态） */
  loadingOlderBySession: Record<string, boolean>;
  /** 各会话是否正在运行 */
  runningBySession: Record<string, boolean>;
  /** 各会话的待发送队列 */
  queueBySession: Record<string, QueuedMessage[]>;
  pendingApprovals: ApprovalRequest[];
  /** 各会话最近一次压缩摘要 */
  compactionNotices: Record<string, string>;
  loading: boolean;

  loadSessions(): Promise<void>;
  setActiveSession(id: string | null): Promise<void>;
  loadMessages(id: string, opts?: { before?: boolean }): Promise<void>;
  createSession(): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  archiveSession(id: string, archived: boolean): Promise<void>;
  removeSession(id: string): Promise<void>;
  forkSession(id: string, entryId: string): Promise<void>;
  send(text: string, images?: { data: string; mimeType: string }[]): Promise<void>;
  /** 编辑用户消息：替换为新文本并从该处重跑（回退到父条目） */
  editUserMessage(messageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
  queue(text: string, mode: "steer" | "followUp"): Promise<void>;
  compact(instructions?: string): Promise<void>;
  /** 重新生成最后一条助手回复：截断到最后一条用户消息并重发 */
  reload(): Promise<void>;
  /** 核心 reducer：按事件类型更新状态，未知事件忽略不抛错 */
  applyEvent(sessionId: string, event: ChatEvent): void;
  resolveApproval(id: string, decision: ApprovalDecision, note?: string): Promise<void>;
  setRunning(id: string, running: boolean): void;
}

/** 消息已存在则按 id 替换，否则追加到尾部 */
function upsertMessage(
  state: ChatState,
  sessionId: string,
  message: ChatMessage,
): Pick<ChatState, "messagesBySession"> {
  const list = state.messagesBySession[sessionId] ?? [];
  const index = list.findIndex((m) => m.id === message.id);
  const next = index >= 0 ? list.map((m, i) => (i === index ? message : m)) : [...list, message];
  return { messagesBySession: { ...state.messagesBySession, [sessionId]: next } };
}

/** 对指定消息做局部更新（找不到则原样返回） */
function updateMessage(
  state: ChatState,
  sessionId: string,
  messageId: string,
  patch: (message: ChatMessage) => ChatMessage,
): Pick<ChatState, "messagesBySession"> {
  const list = state.messagesBySession[sessionId] ?? [];
  return {
    messagesBySession: {
      ...state.messagesBySession,
      [sessionId]: list.map((m) => (m.id === messageId ? patch(m) : m)),
    },
  };
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  pageCursorBySession: {},
  hasMoreBySession: {},
  loadingOlderBySession: {},
  runningBySession: {},
  queueBySession: {},
  pendingApprovals: [],
  compactionNotices: {},
  loading: false,

  async loadSessions() {
    set({ loading: true });
    try {
      const sessions = await window.polaragent.sessions.list();
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ sessions });
    } finally {
      set({ loading: false });
    }
  },

  async setActiveSession(id) {
    set({ activeSessionId: id });
    // 首次激活的会话才需要拉消息；已加载过的直接复用
    if (id && get().messagesBySession[id] === undefined) {
      await get().loadMessages(id);
    }
  },

  async loadMessages(id, opts) {
    const before = opts?.before;
    const beforeSeq = before ? get().pageCursorBySession[id] : undefined;
    if (before && beforeSeq === undefined) return;
    // 同一会话已有一次翻页在飞就跳过：自动加载会在滚动中反复触发
    if (before && get().loadingOlderBySession[id] === true) return;
    if (before) {
      set((state) => ({
        loadingOlderBySession: { ...state.loadingOlderBySession, [id]: true },
      }));
    }
    try {
      const page = await window.polaragent.sessions.loadMessages(id, {
        limit: PAGE_SIZE,
        beforeSeq,
      });
      const cursor = page.nextCursor;
      set((state) => {
        const existing = state.messagesBySession[id] ?? [];
        // 首页整体替换；向上翻页时更早的消息前插
        const messages = before ? [...page.messages, ...existing] : page.messages;
        return {
          messagesBySession: { ...state.messagesBySession, [id]: messages },
          pageCursorBySession: { ...state.pageCursorBySession, [id]: cursor },
          hasMoreBySession: { ...state.hasMoreBySession, [id]: cursor !== undefined },
        };
      });
    } finally {
      if (before) {
        set((state) => ({
          loadingOlderBySession: { ...state.loadingOlderBySession, [id]: false },
        }));
      }
    }
  },

  async createSession() {
    const session = await window.polaragent.sessions.create();
    set((state) => ({ sessions: [session, ...state.sessions] }));
    await get().setActiveSession(session.id);
  },

  async renameSession(id, title) {
    await window.polaragent.sessions.rename(id, title);
    await get().loadSessions();
  },

  async archiveSession(id, archived) {
    await window.polaragent.sessions.setArchived(id, archived);
    await get().loadSessions();
    // 归档当前会话时切走
    if (archived && get().activeSessionId === id) {
      await get().setActiveSession(null);
    }
  },

  async removeSession(id) {
    await window.polaragent.sessions.remove(id);
    await get().loadSessions();
    if (get().activeSessionId === id) {
      await get().setActiveSession(null);
    }
  },

  async forkSession(id, entryId) {
    const forked = await window.polaragent.sessions.fork(id, entryId);
    await get().loadSessions();
    await get().setActiveSession(forked.id);
  },

  async send(text, images) {
    let sessionId = get().activeSessionId;
    if (!sessionId) {
      await get().createSession();
      sessionId = get().activeSessionId;
    }
    if (!sessionId) return;
    // 乐观追加用户消息，不等主进程 message-added，避免输入框闪烁
    const optimistic: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: Date.now(),
      parts: [
        ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
        ...(images?.map((image) => ({
          type: "image" as const,
          mimeType: image.mimeType,
          dataUrl: image.data,
        })) ?? []),
      ],
      status: "complete",
    };
    set((state) => {
      const list = state.messagesBySession[sessionId] ?? [];
      return {
        messagesBySession: { ...state.messagesBySession, [sessionId]: [...list, optimistic] },
      };
    });
    // 带上乐观消息 id：主进程回显该用户消息时复用同 id，避免 UI 出现两条
    await window.polaragent.chat.send(sessionId, text, images, optimistic.id);
  },

  async stop() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.polaragent.chat.stop(sessionId);
    set((state) => ({ runningBySession: { ...state.runningBySession, [sessionId]: false } }));
  },

  async queue(text, mode) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.polaragent.chat.queue(sessionId, text, mode);
  },

  async compact(instructions) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.polaragent.chat.compact(sessionId, instructions);
  },

  async reload() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    // 运行中不做重载，避免打断流式输出
    if (get().runningBySession[sessionId]) return;
    const list = get().messagesBySession[sessionId] ?? [];
    let lastUserIndex = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }
    const lastUser = lastUserIndex >= 0 ? list[lastUserIndex] : undefined;
    if (!lastUser) return;
    const text = lastUser.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const images = lastUser.parts
      .filter((p) => p.type === "image")
      .map((p) => ({ data: p.dataUrl, mimeType: p.mimeType }));
    /**
     * 重新生成：截断到最后一条用户消息（含）再重发，也就是**替换**当前这条回复。
     *
     * 不试图让新回复成为旧回复的兄弟：pi 的 `acceptRun` 会拒收空 prompt
     * （`InvalidMessage{reason:"empty"}`，「Acceptance must append at least one message」），
     * 所以「回退到该用户条目 + 空 prompt 沿用旧消息」这条路走不通；
     * 照旧传文本则会在历史里多写一条重复的用户消息。
     * 代价是重新生成后无法在旧回复之间切换 —— 这是明确接受的取舍。
     *
     * 复用被保留的用户消息 id，避免重发时 UI 里出现两条。
     */
    set((state) => ({
      messagesBySession: {
        ...state.messagesBySession,
        [sessionId]: list.slice(0, lastUserIndex + 1),
      },
    }));
    await window.polaragent.chat.send(sessionId, text, images, lastUser.id);
  },

  /**
   * 编辑用户消息：把这条替换成新文本并重跑。
   *
   * 与重新生成的区别是「回退到**父条目**、把新文本作为新用户消息发出」，
   * 所以新用户条目与旧的是兄弟（同父），旧消息与它之后的回复都不再在 tip 上。
   * 列表同步截断到该消息之前 —— 那些回复既然已被回退掉，就不该再显示。
   */
  async editUserMessage(messageId, text) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if (get().runningBySession[sessionId]) return;
    const list = get().messagesBySession[sessionId] ?? [];
    const index = list.findIndex((m) => m.id === messageId);
    const target = index >= 0 ? list[index] : undefined;
    if (target?.role !== "user") return;
    /**
     * 回退点必须是**已知**的父条目。
     *
     * `parentId` 缺失说明这条消息还没落盘（乐观消息，或运行失败时没配到条目），
     * 此时拼 `?? null` 会被当成「回退到会话开头」，把整段历史从 tip 上摘掉 ——
     * 列表看着还在，模型那边已经清零。宁可不动。
     */
    const parentId = target.parentId;
    if (parentId === undefined) {
      console.warn("该消息尚未落盘，无法编辑");
      return;
    }

    set((state) => ({
      messagesBySession: { ...state.messagesBySession, [sessionId]: list.slice(0, index) },
    }));

    try {
      await window.polaragent.chat.send(sessionId, text, undefined, undefined, {
        rewindToEntryId: parentId,
      });
    } catch (error) {
      // 已截断的列表无法干净回滚（磁盘那边可能已经回退），但至少把失败暴露出来
      console.warn(`编辑消息失败：${String(error)}`);
      await get().loadMessages(sessionId);
    }
  },

  applyEvent(sessionId, event) {
    switch (event.type) {
      case "run-started":
        set((state) => ({ runningBySession: { ...state.runningBySession, [sessionId]: true } }));
        break;
      case "message-added":
        set((state) => upsertMessage(state, sessionId, event.message));
        break;
      case "part-upsert":
        set((state) =>
          updateMessage(state, sessionId, event.messageId, (message) => {
            const parts = [...message.parts];
            if (event.partIndex < parts.length) {
              parts[event.partIndex] = event.part;
            } else {
              parts.push(event.part);
            }
            return { ...message, parts };
          }),
        );
        break;
      case "message-updated":
        set((state) =>
          updateMessage(state, sessionId, event.messageId, (message) => ({
            ...message,
            ...event.patch,
          })),
        );
        break;
      case "queue-updated":
        set((state) => ({ queueBySession: { ...state.queueBySession, [sessionId]: event.items } }));
        break;
      case "approval-requested":
        set((state) => {
          const exists = state.pendingApprovals.some((a) => a.id === event.request.id);
          if (exists) return state;
          return { pendingApprovals: [...state.pendingApprovals, event.request] };
        });
        break;
      case "approval-resolved":
        set((state) => ({
          pendingApprovals: state.pendingApprovals.filter((a) => a.id !== event.id),
        }));
        break;
      case "compaction-started":
        set((state) => ({ compactionNotices: { ...state.compactionNotices, [sessionId]: "" } }));
        break;
      case "compaction-ended":
        set((state) => ({
          compactionNotices: { ...state.compactionNotices, [sessionId]: event.summaryPreview },
        }));
        break;
      case "run-ended":
        set((state) => ({
          runningBySession: { ...state.runningBySession, [sessionId]: false },
          queueBySession: { ...state.queueBySession, [sessionId]: [] },
        }));
        break;
      default:
        // 未知事件类型：忽略，向前兼容
        break;
    }
  },

  async resolveApproval(id, decision, note) {
    await window.polaragent.approvals.respond(id, decision, note);
    set((state) => ({ pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id) }));
  },

  setRunning(id, running) {
    set((state) => ({ runningBySession: { ...state.runningBySession, [id]: running } }));
  },
}));
