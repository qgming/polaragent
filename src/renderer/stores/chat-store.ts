import { create } from "zustand";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ChatEvent,
  ChatMessage,
  ModelRef,
  QueuedMessage,
  SessionSummary,
  SetSessionModelResult,
} from "@/shared/contracts";

/** 单页加载的消息条数 */
const PAGE_SIZE = 40;

interface ChatState {
  /** 会话列表（按 updatedAt 降序） */
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** 各会话的消息列表（时间升序） */
  messagesBySession: Record<string, ChatMessage[]>;
  /**
   * 已经从磁盘拉过首页的会话。不能用「messagesBySession 里有没有数组」当加载标记：
   * 后台会话的事件会先建出数组（只有流式的那几条），此时仍缺磁盘上的历史。
   */
  loadedSessions: Record<string, true>;
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
  /** 新建会话；带 cwd 时该会话归属到对应项目（也决定它的工作目录） */
  createSession(options?: { cwd?: string }): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  archiveSession(id: string, archived: boolean): Promise<void>;
  /** 置顶/取消置顶：置顶的会话在侧栏「置顶」分组里 */
  pinSession(id: string, pinned: boolean): Promise<void>;
  /**
   * 切换会话模型（null = 跟随设置里的默认模型）。运行时立即生效；
   * 失败时返回原因（正在运行 / 目标模型不存在），界面据此说明。
   */
  setSessionModel(id: string, model: ModelRef | null): Promise<SetSessionModelResult>;
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

/**
 * 首页消息与「事件已经累积出来的尾部」合并。
 *
 * 后台会话在用户打开它之前就已经通过事件累积了一段消息（只有流式期间那几条），
 * 打开时要把它接在磁盘历史后面 —— 直接替换会把正在流式的回复弄丢，
 * 而原样拼起来又可能同一条消息出现两次（磁盘那版带 entryId，事件那版带主进程
 * 回填的 entryId，两边 id 不一定相同），所以按 id 与 entryId 双向去重。
 */
export function mergeLoadedPage(
  page: readonly ChatMessage[],
  accumulated: readonly ChatMessage[],
): ChatMessage[] {
  if (accumulated.length === 0) return [...page];
  const knownIds = new Set(page.map((message) => message.id));
  const knownEntries = new Set(
    page
      .map((message) => message.entryId)
      .filter((entryId): entryId is string => typeof entryId === "string"),
  );
  const tail = accumulated.filter(
    (message) =>
      !knownIds.has(message.id) &&
      (message.entryId === undefined || !knownEntries.has(message.entryId)),
  );
  return [...page, ...tail];
}

/**
 * 「替换这条用户消息及其后的回复」的执行计划。
 *
 * 关键在回退点取该消息的**父条目**，而不是它自己：这样新用户条目与旧的成为兄弟（同父），
 * 旧消息与它之后的回复**都不再在 tip 路径上**。这一点同时决定了两件事：
 *   · 界面上旧回复消失（调用方会按 keepCount 截断）
 *   · fork 新会话时不会把旧回复一起复制过去 —— 复制的是「根 → 当前条目」这一条路径
 *
 * 早先重新生成只做「截断列表 + 重发」而不回退，新用户条目的父级因此是**旧回复**，
 * 于是旧回复仍在 tip 路径上，fork 时新旧回复会一起出现在新会话里。
 *
 * `mode` 决定那条用户消息本身留不留：
 *   · `resend`（重新生成）：文本没变，保留它并把它的 UI id 回传给主进程 →
 *     回显时按同一个 id 原地替换，界面不闪
 *   · `edit`（编辑）：文本变了，立刻移除且**不复用 id** → 新消息作为新条目出现，
 *     否则会短暂显示改前的旧文本
 *
 * @returns `null` 表示这条不能这样替换（不是用户消息，或父级未知）
 */
export function planRewrite(
  messages: readonly ChatMessage[],
  index: number,
  mode: "resend" | "edit",
): { keepCount: number; rewindTo: string | null; reuseId: string | null } | null {
  const target = messages[index];
  if (target?.role !== "user") return null;
  /**
   * 父级未知（尚未落盘）时不能替换：拼 `null` 会被当成「回退到会话开头」，
   * 把整段历史从 tip 上摘掉 —— 列表看着还在，模型那边已经清零。
   */
  if (target.parentId === undefined) return null;
  return mode === "resend"
    ? { keepCount: index + 1, rewindTo: target.parentId, reuseId: target.id }
    : { keepCount: index, rewindTo: target.parentId, reuseId: null };
}

/** store 自己的 `set`；只用到「返回部分状态」这一种形式 */
type StoreSet = (updater: (state: ChatState) => Partial<ChatState>) => void;

/** 重发用户消息时附带的图片 */
export interface RewriteImages {
  data: string;
  mimeType: string;
}

/**
 * 按计划替换用户消息：先截断界面列表，再回退到父条目重发。
 *
 * 两处必须一起做，缺一不可：
 *   · 截断 —— 旧回复在界面上立刻消失（不是留在分支上等切换）
 *   · 带 rewindToEntryId —— 旧的用户条目与回复**落到 tip 路径之外**，
 *     于是 fork 新会话时不会把它们一起复制过去
 * 只截断不回退，就是之前那个「重新生成后 fork 出来新旧回复都在」的 bug。
 *
 * keepCount 含这条用户消息本身：新用户消息复用同一个 UI id，到达时原地替换，
 * 界面上不会闪一下「消失又出现」。
 */
async function rewriteUserMessage(
  set: StoreSet,
  get: () => ChatState,
  sessionId: string,
  plan: { keepCount: number; rewindTo: string | null; reuseId: string | null },
  list: ChatMessage[],
  text: string,
  images: RewriteImages[] | undefined,
): Promise<void> {
  const kept = list.slice(0, plan.keepCount);

  set((state) => ({
    messagesBySession: { ...state.messagesBySession, [sessionId]: kept },
  }));

  try {
    await window.oint.chat.send(sessionId, text, images, plan.reuseId ?? undefined, {
      rewindToEntryId: plan.rewindTo,
    });
  } catch (error) {
    // 已截断的列表无法干净回滚（磁盘那边可能已经回退），但至少别让失败静默
    console.warn(`替换用户消息失败：${String(error)}`);
    await get().loadMessages(sessionId);
  }
}

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messagesBySession: {},
  loadedSessions: {},
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
      const sessions = await window.oint.sessions.list();
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      set({ sessions });
    } finally {
      set({ loading: false });
    }
  },

  async setActiveSession(id) {
    set({ activeSessionId: id });
    // 首次激活的会话才需要拉消息；已经拉过的直接复用内存里的（含事件累积的流式内容）
    if (id && get().loadedSessions[id] !== true) {
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
      const page = await window.oint.sessions.loadMessages(id, {
        limit: PAGE_SIZE,
        beforeSeq,
      });
      const cursor = page.nextCursor;
      set((state) => {
        const existing = state.messagesBySession[id] ?? [];
        // 首页：磁盘历史 + 事件累积的尾部（见 mergeLoadedPage）；向上翻页时更早的消息前插
        const messages = before
          ? [...page.messages, ...existing]
          : mergeLoadedPage(page.messages, existing);
        return {
          messagesBySession: { ...state.messagesBySession, [id]: messages },
          loadedSessions: before ? state.loadedSessions : { ...state.loadedSessions, [id]: true },
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

  async createSession(options) {
    const session = await window.oint.sessions.create(options);
    set((state) => ({ sessions: [session, ...state.sessions] }));
    await get().setActiveSession(session.id);
  },

  async renameSession(id, title) {
    await window.oint.sessions.rename(id, title);
    await get().loadSessions();
  },

  async archiveSession(id, archived) {
    await window.oint.sessions.setArchived(id, archived);
    await get().loadSessions();
    // 归档当前会话时切走
    if (archived && get().activeSessionId === id) {
      await get().setActiveSession(null);
    }
  },

  async pinSession(id, pinned) {
    await window.oint.sessions.setPinned(id, pinned);
    // 就地改一个布尔字段，不必整表重拉：重拉会顺带刷新顺序与时间，置顶不该改动它们
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, pinned } : session,
      ),
    }));
  },

  async setSessionModel(id, model) {
    const result = await window.oint.sessions.setModel(id, model);
    if (!result.ok) return result;
    // 就地改字段：模型只影响这一个会话的显示与请求，重拉整表会顺带刷新排序，没必要
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, model } : session,
      ),
    }));
    return result;
  },

  async removeSession(id) {
    await window.oint.sessions.remove(id);
    await get().loadSessions();
    if (get().activeSessionId === id) {
      await get().setActiveSession(null);
    }
  },

  async forkSession(id, entryId) {
    const forked = await window.oint.sessions.fork(id, entryId);
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
    await window.oint.chat.send(sessionId, text, images, optimistic.id);
  },

  async stop() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.oint.chat.stop(sessionId);
    set((state) => ({ runningBySession: { ...state.runningBySession, [sessionId]: false } }));
  },

  async queue(text, mode) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.oint.chat.queue(sessionId, text, mode);
  },

  async compact(instructions) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.oint.chat.compact(sessionId, instructions);
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
    const plan = planRewrite(list, lastUserIndex, "resend");
    if (plan === null) {
      console.warn("该用户消息尚未落盘，无法重新生成");
      return;
    }
    const text = lastUser.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");
    const images = lastUser.parts
      .filter((p) => p.type === "image")
      .map((p) => ({ data: p.dataUrl, mimeType: p.mimeType }));

    await rewriteUserMessage(set, get, sessionId, plan, list, text, images);
  },

  /**
   * 编辑用户消息：把这条替换成新文本并重跑。
   *
   * 与重新生成走同一条路径（见 planRewrite），区别只是文本来源与是否带图片：
   * 都是「回退到该消息的父条目 + 把用户消息重新发出」，旧回复因此不在 tip 路径上。
   */
  async editUserMessage(messageId, text) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    if (get().runningBySession[sessionId]) return;
    const list = get().messagesBySession[sessionId] ?? [];
    const index = list.findIndex((m) => m.id === messageId);
    const plan = planRewrite(list, index, "edit");
    if (plan === null) {
      console.warn("该消息不能编辑（不是用户消息，或尚未落盘）");
      return;
    }

    await rewriteUserMessage(set, get, sessionId, plan, list, text, undefined);
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
      // AI 出结论但不放行：卡片交回用户（保持挂起，理由随事件一起更新）
      case "approval-reviewed":
        set((state) => ({
          pendingApprovals: state.pendingApprovals.map((item) =>
            item.id === event.id ? { ...item, aiReviewed: true, reason: event.reason } : item,
          ),
        }));
        break;
      // AI 自动命名：主进程已落盘，这里就地替换列表里的默认名（用事件自带的会话 id）
      case "session-titled":
        set((state) => ({
          sessions: state.sessions.map((session) =>
            session.id === event.sessionId ? { ...session, title: event.title } : session,
          ),
        }));
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
        // 后台会话跑完了：主进程已经刷新了它的 updatedAt，拉一次列表让侧栏顺序跟上。
        // 当前会话不拉 —— 用户正看着的列表不该在眼前重排（它下次交互时自然会被刷新）。
        if (sessionId !== get().activeSessionId) {
          void get()
            .loadSessions()
            .catch((error: unknown) => {
              console.warn(`刷新会话列表失败：${String(error)}`);
            });
        }
        break;
      default:
        // 未知事件类型：忽略，向前兼容
        break;
    }
  },

  async resolveApproval(id, decision, note) {
    await window.oint.approvals.respond(id, decision, note);
    set((state) => ({ pendingApprovals: state.pendingApprovals.filter((a) => a.id !== id) }));
  },

  setRunning(id, running) {
    set((state) => ({ runningBySession: { ...state.runningBySession, [id]: running } }));
  },
}));
