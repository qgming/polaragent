import { create } from "zustand";
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  AskReply,
  AskRequest,
  ChatEvent,
  ChatMessage,
  ChatPart,
  ChatStreamSnapshot,
  ContextBreakdown,
  JobInfo,
  ModelRef,
  QueuedMessage,
  SessionStats,
  SessionSummary,
  SessionTokenUsage,
  SetSessionModelResult,
  SetSessionModeResult,
} from "@/shared/contracts";

/** 单页加载的消息条数 */
const PAGE_SIZE = 40;

/**
 * 流式 part 事件的合帧窗口（毫秒）。
 *
 * 为什么需要它：主进程每个 token 发一条事件（part-delta 是增量，已很小），
 * 但渲染层**每条事件一次 set** 就等于一次同步 React 渲染（zustand 走
 * useSyncExternalStore，跨事件不批处理）。多路流并行时每秒上百条事件，主线程被
 * 一个个渲染任务切碎，滚动与点击全部排队 —— 表现就是「界面卡死」。
 *
 * 32ms 与 30fps 对齐：文本以肉眼连续的节奏增长，而渲染频率与 token 速率解耦。
 * 这只是「合帧」而不是「节流到看不见」：窗口内的增量全部保留（拼接在一起）。
 */
const STREAM_FLUSH_INTERVAL_MS = 32;

/** 缓冲区里的事件条数上限：超出就先提交一次，避免后台窗口 rAF/定时器被拖慢时无限堆积 */
const STREAM_BUFFER_LIMIT = 400;

/**
 * 同一个 part 的待提交状态。
 *
 * `base` 是最近一次 part-upsert 的**全量** part（创建 / text_end / toolcall_end 等），
 * 增量只在 base 之后做字符串拼接。这个次序保证「先创建（空文本）→ 增量 → 收尾全量」
 * 三段都能正确合并：upsert 会清空此前累积的增量（它已经包含那些内容），
 * 之后的增量再从零累积。
 */
interface PartBufferEntry {
  base?: ChatPart;
  textDelta: string;
  reasoningDelta: string;
  argsDelta: string;
}

/** sessionId → messageId → partIndex → 待提交状态 */
type PartBuffer = Map<string, Map<string, Map<number, PartBufferEntry>>>;

const partBuffers: PartBuffer = new Map();
/** 检测到增量缺口的会话（消息/part 不存在）：flush 后逐个用快照重同步 */
const resyncSessions = new Set<string>();
/** 快照重同步的在飞闸门 + 防抖（异常情况下不许把快照 IPC 打成风暴） */
const resyncInFlight = new Set<string>();
const lastResyncAt = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 取（或建）某个 part 的缓冲条目 */
function bufferEntry(
  messageBuffer: Map<string, Map<number, PartBufferEntry>>,
  messageId: string,
  partIndex: number,
): PartBufferEntry {
  let byPart = messageBuffer.get(messageId);
  if (byPart === undefined) {
    byPart = new Map();
    messageBuffer.set(messageId, byPart);
  }
  let entry = byPart.get(partIndex);
  if (entry === undefined) {
    entry = { textDelta: "", reasoningDelta: "", argsDelta: "" };
    byPart.set(partIndex, entry);
  }
  return entry;
}

function bufferUpsert(
  sessionId: string,
  messageId: string,
  partIndex: number,
  part: ChatPart,
): void {
  let bySession = partBuffers.get(sessionId);
  if (bySession === undefined) {
    bySession = new Map();
    partBuffers.set(sessionId, bySession);
  }
  const entry = bufferEntry(bySession, messageId, partIndex);
  entry.base = part;
  // upsert 是全量：此前累积的增量都已包含在它里面
  entry.textDelta = "";
  entry.reasoningDelta = "";
  entry.argsDelta = "";
}

function bufferDelta(
  sessionId: string,
  messageId: string,
  partIndex: number,
  kind: "text" | "reasoning" | "args",
  delta: string,
): void {
  let bySession = partBuffers.get(sessionId);
  if (bySession === undefined) {
    bySession = new Map();
    partBuffers.set(sessionId, bySession);
  }
  const entry = bufferEntry(bySession, messageId, partIndex);
  if (kind === "text") entry.textDelta += delta;
  else if (kind === "reasoning") entry.reasoningDelta += delta;
  else entry.argsDelta += delta;
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushStreamEvents();
  }, STREAM_FLUSH_INTERVAL_MS);
}

/** 缓冲区里的事件条数（测试与上限判断用） */
function bufferedEventCount(): number {
  let count = 0;
  for (const bySession of partBuffers.values()) {
    for (const byPart of bySession.values()) count += byPart.size;
  }
  return count;
}

/** 把增量拼到 part 上；没有可拼内容时返回 null（避免无谓的新对象） */
function appendDeltas(part: ChatPart, entry: PartBufferEntry): ChatPart | null {
  if (part.type === "text") {
    if (entry.textDelta === "") return null;
    return { ...part, text: part.text + entry.textDelta };
  }
  if (part.type === "reasoning") {
    if (entry.reasoningDelta === "") return null;
    return { ...part, text: part.text + entry.reasoningDelta };
  }
  if (part.type === "tool-call") {
    if (entry.argsDelta === "") return null;
    return { ...part, argsText: part.argsText + entry.argsDelta };
  }
  return null;
}

/**
 * 一次 flush：把缓冲的 part 事件合批写进 store（一次 set = 一次渲染）。
 *
 * 缺口处理：消息不存在（错过 message-added）、part 下标对不上、增量没有可落的 part
 * （错过创建）—— 这三种情况都说明增量链断了，标记该会话在 flush 后走快照重同步。
 */
function flushBuffers(pending: PartBuffer): Partial<ChatState> | null {
  let messagesBySession = useChatStore.getState().messagesBySession;
  let changed = false;

  for (const [sessionId, bySession] of pending) {
    const list = messagesBySession[sessionId];
    let nextList = list ?? [];
    let sessionChanged = false;

    for (const [messageId, byPart] of bySession) {
      const messageIndex = nextList.findIndex((message) => message.id === messageId);
      if (messageIndex < 0) {
        resyncSessions.add(sessionId);
        continue;
      }
      const message = nextList[messageIndex];
      if (message === undefined) continue;
      const parts = [...message.parts];
      let partsChanged = false;

      for (const [partIndex, entry] of byPart) {
        const existing = parts[partIndex];
        if (entry.base === undefined && existing === undefined) {
          // 增量落在不存在的 part 上：错过创建事件，整条补齐
          resyncSessions.add(sessionId);
          continue;
        }
        if (entry.base !== undefined) {
          if (partIndex < parts.length) parts[partIndex] = entry.base;
          else if (partIndex === parts.length) parts.push(entry.base);
          else {
            // 下标跳跃：中间还有没见过的 part，拼下去就是错位的
            resyncSessions.add(sessionId);
            continue;
          }
          partsChanged = true;
        }
        const target = parts[partIndex];
        if (target === undefined) continue;
        const patched = appendDeltas(target, entry);
        if (patched !== null) {
          parts[partIndex] = patched;
          partsChanged = true;
        }
      }

      if (partsChanged) {
        nextList = nextList.map((item, index) =>
          index === messageIndex ? { ...item, parts } : item,
        );
        sessionChanged = true;
      }
    }

    if (sessionChanged) {
      messagesBySession = { ...messagesBySession, [sessionId]: nextList };
      changed = true;
    }
  }

  return changed ? { messagesBySession } : null;
}

/** 把快照整条落到 store：消息不存在就补建一条（窗口重载中途接上流） */
function applyStreamSnapshot(
  state: ChatState,
  sessionId: string,
  snapshot: ChatStreamSnapshot,
): Partial<ChatState> {
  const list = state.messagesBySession[sessionId] ?? [];
  const index = list.findIndex((message) => message.id === snapshot.messageId);
  const existing = index >= 0 ? list[index] : undefined;
  const next: ChatMessage =
    existing !== undefined
      ? { ...existing, parts: snapshot.parts }
      : {
          id: snapshot.messageId,
          role: "assistant",
          createdAt: snapshot.createdAt,
          parts: snapshot.parts,
          status: "streaming",
        };
  const messages =
    existing !== undefined ? list.map((item, i) => (i === index ? next : item)) : [...list, next];
  return { messagesBySession: { ...state.messagesBySession, [sessionId]: messages } };
}

/** flush 时发现过缺口的会话：拉一次完整快照整条补齐 */
function maybeResync(): void {
  if (resyncSessions.size === 0) return;
  for (const sessionId of [...resyncSessions]) {
    resyncSessions.delete(sessionId);
    void resyncStream(sessionId);
  }
}

async function resyncStream(sessionId: string): Promise<void> {
  if (resyncInFlight.has(sessionId)) return;
  const last = lastResyncAt.get(sessionId) ?? 0;
  if (Date.now() - last < 1000) return;
  // 测试环境没有 preload 桥：安静跳过（缺口只是渲染不完整，不该让测试炸掉）
  const bridge = typeof window === "undefined" ? undefined : window.oint?.chat;
  if (bridge === undefined) return;

  lastResyncAt.set(sessionId, Date.now());
  resyncInFlight.add(sessionId);
  try {
    const snapshot = await bridge.snapshot(sessionId);
    if (snapshot !== null) {
      useChatStore.setState((state) => applyStreamSnapshot(state, sessionId, snapshot));
    }
  } catch (error) {
    console.warn(`补齐流式快照失败：${String(error)}`);
  } finally {
    resyncInFlight.delete(sessionId);
  }
}

/**
 * 立即提交缓冲的流式 part 事件（同步）。
 *
 * 两个调用场景：
 *   · 结构事件（message-updated / run-ended 等）到达前先把 part 落定，保证顺序语义；
 *   · 测试里显式推进（合帧窗口不参与断言时序）。
 */
export function flushStreamEvents(sessionId?: string): void {
  if (partBuffers.size === 0) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    return;
  }
  if (sessionId !== undefined && !partBuffers.has(sessionId)) return;

  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  const ids = sessionId === undefined ? [...partBuffers.keys()] : [sessionId];
  const pending: PartBuffer = new Map();
  for (const id of ids) {
    const buffered = partBuffers.get(id);
    if (buffered === undefined) continue;
    partBuffers.delete(id);
    pending.set(id, buffered);
  }

  const partial = flushBuffers(pending);
  if (partial !== null) useChatStore.setState(partial);
  // 还有别的会话攒着事件：重新排一次提交
  if (partBuffers.size > 0) scheduleFlush();
  maybeResync();
}

/** 丢弃某会话的待提交 part 事件（消息被截断/会话被移除时调用，防止事件把旧内容拼回来） */
export function clearStreamBuffer(sessionId: string): void {
  partBuffers.delete(sessionId);
  resyncSessions.delete(sessionId);
}

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
  /** 各会话的会话级统计（轮次/步数/耗时），见 session-stats 事件 */
  statsBySession: Record<string, SessionStats>;
  /** 各会话的 Token 用量合计（缓存/未缓存输入/输出），见 token-usage 事件 */
  tokenUsageBySession: Record<string, SessionTokenUsage>;
  /** 各会话的上下文占用分解（系统提示/工具定义/对话消息），见 context-breakdown 事件 */
  breakdownBySession: Record<string, ContextBreakdown>;
  pendingApprovals: ApprovalRequest[];
  /** 各会话的未决提问（模型运行中途提出的问题，按事件到达顺序） */
  pendingAsks: AskRequest[];
  /** 各会话的后台作业（按启动先后升序，与主进程 job_list 的「最老在前」一致） */
  jobsBySession: Record<string, JobInfo[]>;
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
  /**
   * 切换会话的智能体模式（null = 跟随设置里的默认模式）。
   *
   * 下一次发送即生效（模式是**每轮现算**的系统提示，见 runtime 的 composeMainPrompt）；
   * 运行中会被拒绝（reason: "running"），界面据此说明。
   */
  setSessionMode(id: string, mode: AgentMode | null): Promise<SetSessionModeResult>;
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
  /** 回答一次提问；卡片乐观移除，失败再放回（见实现） */
  respondAsk(id: string, reply: AskReply): Promise<void>;
  /** 补拉某会话的未决提问（会话切换 / 打开时恢复卡片） */
  loadPendingAsks(id: string | null): Promise<void>;
  /** 停止一个后台作业（面板上的「停止」按钮）；失败保留原状，见实现 */
  killJob(id: string): Promise<void>;
  /** 补拉某会话的后台作业（会话切换 / 打开时恢复面板） */
  loadJobs(id: string | null): Promise<void>;
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

/** 从一个「按会话 id 索引」的记录里删掉某个会话（键不存在时原样返回，避免无谓的重渲染） */
function omitSession<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
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

  // 截断前先把攒着的流式事件清掉：它们属于被替换掉的旧回复，落下只会把旧文本拼回来
  clearStreamBuffer(sessionId);

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
  statsBySession: {},
  tokenUsageBySession: {},
  breakdownBySession: {},
  pendingApprovals: [],
  pendingAsks: [],
  jobsBySession: {},
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
    // 未决提问跟着会话走：切回来（或重开窗口）时要能从主进程的未决表把卡片补回来
    await get().loadPendingAsks(id);
    // 后台作业同理：事件只在「作业变动时就开着这个会话」时到过，切回来要补拉一次
    await get().loadJobs(id);
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
      /**
       * 持久化的用量快照：只在**首页**落地。
       *
       * 向上翻页返回的是更早的批次，带上的是同一份索引记录 —— 每次翻页都覆盖一遍
       * 只会把「本轮刚跑出来的实时数据」用旧快照盖掉（翻页可能发生在运行中）。
       */
      const usage = before ? undefined : page.usage;
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
          ...(usage === undefined
            ? {}
            : {
                statsBySession: { ...state.statsBySession, [id]: usage.stats },
                tokenUsageBySession: { ...state.tokenUsageBySession, [id]: usage.tokenUsage },
                breakdownBySession: { ...state.breakdownBySession, [id]: usage.breakdown },
              }),
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

  /**
   * 切换会话的智能体模式（与 setSessionModel 同构，只是字段不同）。
   *
   * 落盘后**只就地改这一个会话的字段**，不重拉整表：模式不影响排序与时间。
   * 主进程在**下一次请求装配时**读它（runtime 的 composeMainPrompt），
   * 所以这里不需要通知运行中的会话 —— 事实上运行中会被主进程拒绝（reason: "running"）。
   */
  async setSessionMode(id, mode) {
    const result = await window.oint.sessions.setMode(id, mode);
    if (!result.ok) return result;
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, agentMode: mode } : session,
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
    // 会话已从磁盘消失：把它留下的每会话缓存整批清掉（消息、翻页游标、队列、作业、未决卡片），
    // 否则这些记录会一直挂在内存里，还可能与将来复用的会话 id 串味
    clearStreamBuffer(id);
    set((state) => ({
      messagesBySession: omitSession(state.messagesBySession, id),
      loadedSessions: omitSession(state.loadedSessions, id),
      pageCursorBySession: omitSession(state.pageCursorBySession, id),
      hasMoreBySession: omitSession(state.hasMoreBySession, id),
      loadingOlderBySession: omitSession(state.loadingOlderBySession, id),
      runningBySession: omitSession(state.runningBySession, id),
      queueBySession: omitSession(state.queueBySession, id),
      statsBySession: omitSession(state.statsBySession, id),
      tokenUsageBySession: omitSession(state.tokenUsageBySession, id),
      breakdownBySession: omitSession(state.breakdownBySession, id),
      jobsBySession: omitSession(state.jobsBySession, id),
      compactionNotices: omitSession(state.compactionNotices, id),
      pendingApprovals: state.pendingApprovals.filter((item) => item.sessionId !== id),
      pendingAsks: state.pendingAsks.filter((item) => item.sessionId !== id),
    }));
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
    // 停止前把攒着的文本先落定：主进程随后不会再补发收尾全量，被丢在缓冲里就是永久缺一段
    flushStreamEvents(sessionId);
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
    /**
     * 高频流式事件进合帧缓冲：**不是丢掉，是攒着一次性提交**。
     * 正文/推理/工具参数的每个 token 都走这里；一次 flush = 一次 set = 一次渲染。
     */
    if (event.type === "part-delta") {
      bufferDelta(sessionId, event.messageId, event.partIndex, event.kind, event.delta);
      scheduleFlush();
      if (bufferedEventCount() > STREAM_BUFFER_LIMIT) flushStreamEvents();
      return;
    }
    if (event.type === "part-upsert") {
      bufferUpsert(sessionId, event.messageId, event.partIndex, event.part);
      scheduleFlush();
      if (bufferedEventCount() > STREAM_BUFFER_LIMIT) flushStreamEvents();
      return;
    }
    /**
     * 结构事件（消息结束、运行结束、审批、作业……）低频，立即应用；
     * 但先把该会话攒着的 part 落定 —— 否则「已完成」会先于最后一段文本到达，
     * 界面会有一帧显示「跑完了但文字少一截」。
     */
    flushStreamEvents(sessionId);

    switch (event.type) {
      case "run-started":
        set((state) => ({ runningBySession: { ...state.runningBySession, [sessionId]: true } }));
        break;
      case "message-added":
        set((state) => upsertMessage(state, sessionId, event.message));
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
      case "ask-requested":
        // 同一次 ask_user 调用只登记一条：事件重放 / 与补拉撞上时同 id 只留一条
        set((state) => {
          const exists = state.pendingAsks.some((a) => a.id === event.request.id);
          if (exists) return state;
          return { pendingAsks: [...state.pendingAsks, event.request] };
        });
        break;
      // 已结算（用户作答 / 超时未回应 / 运行被停）：卡片撤下，不留已决态
      case "ask-resolved":
        set((state) => ({
          pendingAsks: state.pendingAsks.filter((a) => a.id !== event.id),
        }));
        break;
      /**
       * 后台作业新建 / 状态变更 / 退出：按 id 覆盖更新，只有新 id 才追加到尾部。
       * 追加在尾部与主进程 job_list 的「最老在前」一致（id 全局自增，新作业必然最新）；
       * 关键是**同一条作业只占一行** —— 状态变更、退出都走这个事件，插入逻辑写错就会越更新越多。
       */
      case "job-changed":
        set((state) => {
          const list = state.jobsBySession[sessionId] ?? [];
          const index = list.findIndex((job) => job.id === event.job.id);
          const next =
            index >= 0
              ? list.map((job, i) => (i === index ? event.job : job))
              : [...list, event.job];
          return { jobsBySession: { ...state.jobsBySession, [sessionId]: next } };
        });
        break;
      // 被淘汰或随会话清理：整条从列表里撤掉
      case "job-removed":
        set((state) => {
          const list = state.jobsBySession[sessionId];
          if (list === undefined) return state;
          return {
            jobsBySession: {
              ...state.jobsBySession,
              [sessionId]: list.filter((job) => job.id !== event.id),
            },
          };
        });
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
      case "session-stats":
        set((state) => ({
          statsBySession: { ...state.statsBySession, [sessionId]: event.stats },
        }));
        break;
      case "token-usage":
        set((state) => ({
          tokenUsageBySession: { ...state.tokenUsageBySession, [sessionId]: event.usage },
        }));
        break;
      case "context-breakdown":
        set((state) => ({
          breakdownBySession: { ...state.breakdownBySession, [sessionId]: event.breakdown },
        }));
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

  /**
   * 回答一次提问：先把请求移出列表（乐观），卡片立刻消失、不等 IPC 回来 ——
   * 否则提交后卡片会一直杵在「提交中」。发送失败时把它放回（卡片重新出现），
   * 并按本 store 里其它后台失败的处置走 console.warn。
   */
  async respondAsk(id, reply) {
    const target = get().pendingAsks.find((item) => item.id === id);
    set((state) => ({ pendingAsks: state.pendingAsks.filter((item) => item.id !== id) }));

    try {
      await window.oint.interaction.respond(id, reply);
    } catch (error) {
      console.warn(`提交回答失败：${String(error)}`);
      if (target !== undefined) set((state) => ({ pendingAsks: [...state.pendingAsks, target] }));
    }
  },

  /**
   * 从主进程补拉某个会话的未决提问。
   *
   * 事件只覆盖「提问发生时就开着这个会话」的情形：切走再切回、或重开窗口之后，
   * 卡片要靠这次补拉复原（主进程的未决表是权威）。失败不影响切换本身 ——
   * 只是卡片暂时缺席，比切不过去轻。
   */
  async loadPendingAsks(id) {
    if (id === null) return;
    try {
      // 拉取期间新到的事件条目要保留：与 ask-requested 抢跑时不能把刚出现的卡片抹掉
      const startedAt = Date.now();
      const requests = await window.oint.interaction.pending(id);
      set((state) => {
        // 该会话的旧条目整体换成拉回来的这份（主进程是未决表的权威），别的会话不动
        const others = state.pendingAsks.filter((item) => item.sessionId !== id);
        const restored = new Map(requests.map((item) => [item.id, item]));
        for (const item of state.pendingAsks) {
          if (item.sessionId === id && item.createdAt >= startedAt) restored.set(item.id, item);
        }
        return {
          pendingAsks: [
            ...others,
            ...[...restored.values()].sort((a, b) => a.createdAt - b.createdAt),
          ],
        };
      });
    } catch (error) {
      console.warn(`恢复未决提问失败：${String(error)}`);
    }
  },

  /**
   * 停止一个后台作业。
   *
   * 主进程 kill 之后返回**已经结算**的快照（status = killed），直接拿它覆盖列表里的那一条：
   * 用户点完立刻看到「已停止」，不必等 close 事件回来。失败（作业已被清理、会话对不上）
   * 时保留原状并按本 store 的惯例 console.warn —— 面板里那一条仍然是真的，只是这次没停掉。
   */
  async killJob(id) {
    const sessionId = get().activeSessionId;
    if (sessionId === null) return;
    try {
      const job = await window.oint.jobs.kill(sessionId, id);
      set((state) => {
        const list = state.jobsBySession[sessionId];
        if (list === undefined) return state;
        return {
          jobsBySession: {
            ...state.jobsBySession,
            [sessionId]: list.map((item) => (item.id === job.id ? job : item)),
          },
        };
      });
    } catch (error) {
      console.warn(`停止后台作业失败：${String(error)}`);
    }
  },

  /**
   * 从主进程补拉某个会话的后台作业。
   *
   * 与 loadPendingAsks 同一套路：事件只覆盖「作业变动时就开着这个会话」的情形，
   * 切走再切回、或重开窗口之后，面板要靠这次补拉复原（主进程的作业表是权威）。
   * 失败不影响切换本身 —— 面板暂时空着，比切不过去轻。
   */
  async loadJobs(id) {
    if (id === null) return;
    try {
      // 拉取期间新到的事件条目要保留：与 job-changed 抢跑时不能把刚起的作业抹掉
      const startedAt = Date.now();
      const jobs = await window.oint.jobs.list(id);
      set((state) => {
        // Map 的插入顺序就是列表顺序：主进程那份在前（最老在前），拉取期间新到的接在后面 ——
        // 新作业的 id 更大、开始得更晚，正好也是「最老在前」
        const restored = new Map(jobs.map((job) => [job.id, job]));
        for (const job of state.jobsBySession[id] ?? []) {
          if (job.startedAt >= startedAt) restored.set(job.id, job);
        }
        return { jobsBySession: { ...state.jobsBySession, [id]: [...restored.values()] } };
      });
    } catch (error) {
      console.warn(`恢复后台作业失败：${String(error)}`);
    }
  },

  setRunning(id, running) {
    set((state) => ({ runningBySession: { ...state.runningBySession, [id]: running } }));
  },
}));
