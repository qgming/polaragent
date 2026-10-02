import { create } from "zustand";
import { attachmentsFromParts, attachmentsToParts } from "@/renderer/runtime/attachment-payload";
import type {
  AgentMode,
  ApprovalDecision,
  ApprovalRequest,
  AskReply,
  AskRequest,
  ChatAttachment,
  ChatEvent,
  ChatLiveSnapshot,
  ChatMessage,
  CompactOutcome,
  ContextBreakdown,
  JobInfo,
  ModelRef,
  QueuedMessage,
  SessionCompaction,
  SessionStats,
  SessionSummary,
  SessionTokenUsage,
  SetSessionModelResult,
  SetSessionModeResult,
} from "@/shared/contracts";
import { acceptViewFrame, mergeViewMessages } from "./chat-view";

/** 单页加载的消息条数 */
const PAGE_SIZE = 40;

type ViewRevision = Pick<ChatLiveSnapshot, "generation" | "revision">;
function revisionAtLeast(current: ViewRevision | undefined, target: ViewRevision): boolean {
  return (
    current !== undefined &&
    (current.generation > target.generation ||
      (current.generation === target.generation && current.revision >= target.revision))
  );
}
const resyncRequests = new Map<string, { target?: ViewRevision; pending: Promise<void> }>();
function restoreNativeView(sessionId: string, target?: ViewRevision): Promise<void> {
  const existing = resyncRequests.get(sessionId);
  if (existing) {
    if (target && !revisionAtLeast(existing.target, target)) existing.target = target;
    return existing.pending;
  }
  const request = { target, pending: Promise.resolve() };
  resyncRequests.set(sessionId, request);
  request.pending = (async () => {
    for (;;) {
      const snapshot = await window.oint.chat.snapshot(sessionId);
      if (!snapshot) return;
      useChatStore.getState().applyEvent(sessionId, { type: "view", frame: snapshot });
      if (
        !request.target ||
        revisionAtLeast(useChatStore.getState().viewsBySession[sessionId], request.target)
      )
        return;
    }
  })().finally(() => {
    if (resyncRequests.get(sessionId) === request) resyncRequests.delete(sessionId);
  });
  return request.pending;
}

interface ChatState {
  /** 会话列表（按 updatedAt 降序） */
  sessions: SessionSummary[];
  activeSessionId: string | null;
  /** 各会话的消息列表（时间升序） */
  messagesBySession: Record<string, ChatMessage[]>;
  viewsBySession: Record<string, ChatLiveSnapshot>;
  historyEpochBySession: Record<string, number>;
  loadingFirstBySession: Record<string, boolean>;
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
  /** 各会话的 Token 用量合计，来自原生 UsageDoc 视图 */
  tokenUsageBySession: Record<string, SessionTokenUsage>;
  /** 各会话的上下文占用分解（系统提示/工具定义/对话消息），见 context-breakdown 事件 */
  breakdownBySession: Record<string, ContextBreakdown>;
  pendingApprovals: ApprovalRequest[];
  /** 各会话的未决提问（模型运行中途提出的问题，按事件到达顺序） */
  pendingAsks: AskRequest[];
  /** 各会话的后台作业（按启动先后升序，与主进程 job_list 的「最老在前」一致） */
  jobsBySession: Record<string, JobInfo[]>;
  /**
   * 收到过**权威列表**（一次成功的 `jobs.list`）的会话。
   *
   * 这份名单是「转录里那条 running 还算不算数」的闸门（见 tool-presentation 的 resolveJobView）：
   * 主进程是唯一知道「这条作业在本进程里是否还活着」的一方，而在它答话之前不能做任何降级 ——
   * 启动瞬间转录先到、`jobs.list` 后到，提前下结论会让满屏历史作业先闪一屏假的终态。
   */
  jobsReconciledSessions: Record<string, true>;
  /**
   * 各会话的压缩状态（最近一次）。
   *
   * 为什么是一个结构而不是「摘要字符串」：渲染层要区分**进行中 / 已完成 / 失败 / 已取消**
   * 四种结局。早先用空串表示「进行中」，而失败的结局也被写成空串 —— 于是一次失败的压缩
   * 会让顶部永久停在「运行中」。
   *
   * 完成后的状态**刻意保留**：顶部那条压缩条平时就是「最近一次压缩」的摘要入口。
   */
  compactions: Record<string, SessionCompaction>;
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
  /**
   * 把会话改绑到某个项目目录（新会话页的「选择项目」）。
   *
   * 失败时抛错，调用方负责说明原因 —— 与 setSessionModel / setSessionMode 那两条
   * 「返回 {ok, reason}」的通道不同：这条通道的失败是**异常**（目录不存在、会话已有消息），
   * 不是可预期的业务分支，主进程没有把它做成结果类型。
   */
  setSessionCwd(id: string, cwd: string): Promise<void>;
  removeSession(id: string): Promise<void>;
  forkSession(id: string, entryId: string): Promise<void>;
  send(text: string, attachments?: ChatAttachment[]): Promise<void>;
  /** 编辑用户消息：替换为新文本并从该处重跑（回退到父条目） */
  editUserMessage(messageId: string, text: string): Promise<void>;
  stop(): Promise<void>;
  queue(text: string, mode: "steer" | "followUp"): Promise<void>;
  /** 撤销一条还没被消费的排队消息（entryId 即 QueuedMessage.id）；失败只记日志 */
  cancelQueued(entryId: string): Promise<void>;
  /**
   * 手动压缩上下文（`/compact` 指令的动作）。
   *
   * 返回结果对象而不是抛错：`busy` / `nothing` 是正常结局，调用方（指令执行器）
   * 要按 code 给不同的话。**乐观态**：调用一发出就先写「进行中」，
   * 因为 IPC 往返 + 内核准入之间有一段没有任何事件的窗口，那段时间界面不能是一片空白
   * （真值仍以内核事件为准：事件一到就覆盖）。
   */
  compact(instructions?: string): Promise<CompactOutcome>;
  /**
   * 收起当前会话的压缩条。
   *
   * 只用于「没有可展开正文」的结局（失败 / 取消）：它们是**一次性提示**，
   * 用户点一下就收掉。完成态不清 —— 那条摘要就是它存在的意义。
   */
  clearCompaction(): void;
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
  /** 补拉某会话的后台作业（会话切换 / 打开时恢复面板）；成功后标记该会话已对账 */
  loadJobs(id: string | null): Promise<void>;
}

/** 消息已存在则按 id 替换，否则追加到尾部 */
function omitSession<T>(record: Record<string, T>, id: string): Record<string, T> {
  if (!(id in record)) return record;
  const next = { ...record };
  delete next[id];
  return next;
}

/** 对指定消息做局部更新（找不到则原样返回） */
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
 *
 * 附件从这条消息的 part 里重建（见 attachmentsFromParts）：字节不在内存里，
 * 主进程按 part 上的 `path` 读回原文件；视频帧则从 part 里带回去 ——
 * 主进程没有解码器，抽不出帧。
 */
async function rewriteUserMessage(
  set: StoreSet,
  get: () => ChatState,
  sessionId: string,
  plan: { keepCount: number; rewindTo: string | null; reuseId: string | null },
  list: ChatMessage[],
  text: string,
  attachments: ChatAttachment[],
): Promise<void> {
  const kept = list.slice(0, plan.keepCount);

  // 截断前先把攒着的流式事件清掉：它们属于被替换掉的旧回复，落下只会把旧文本拼回来

  set((state) => ({
    messagesBySession: { ...state.messagesBySession, [sessionId]: kept },
  }));

  try {
    await window.oint.chat.send(sessionId, text, attachments, plan.reuseId ?? undefined, {
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
  viewsBySession: {},
  historyEpochBySession: {},
  loadingFirstBySession: {},
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
  jobsReconciledSessions: {},
  compactions: {},
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
    if (id) await restoreNativeView(id);
    // 未决提问跟着会话走：切回来（或重开窗口）时要能从主进程的未决表把卡片补回来
    await get().loadPendingAsks(id);
    // 后台作业同理：事件只在「作业变动时就开着这个会话」时到过，切回来要补拉一次
    await get().loadJobs(id);
  },

  async loadMessages(id, opts) {
    const requestedEpoch = get().historyEpochBySession[id] ?? 0;
    const before = opts?.before;
    const beforeSeq = before ? get().pageCursorBySession[id] : undefined;
    if (before && beforeSeq === undefined) return;
    // 同一会话已有一次翻页在飞就跳过：自动加载会在滚动中反复触发
    if (before && get().loadingOlderBySession[id] === true) return;
    if (before) {
      set((state) => ({
        loadingOlderBySession: { ...state.loadingOlderBySession, [id]: true },
      }));
    } else
      set((state) => ({ loadingFirstBySession: { ...state.loadingFirstBySession, [id]: true } }));
    try {
      const page = await window.oint.sessions.loadMessages(id, {
        limit: PAGE_SIZE,
        beforeSeq,
      });
      if ((get().historyEpochBySession[id] ?? 0) !== requestedEpoch) return;
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
        const loadedMessages = before
          ? [...page.messages, ...existing]
          : mergeLoadedPage(page.messages, existing);
        const live = state.viewsBySession[id];
        const messages = live
          ? mergeViewMessages(loadedMessages, live.state, false)
          : loadedMessages;
        return {
          messagesBySession: { ...state.messagesBySession, [id]: messages },
          loadedSessions: before ? state.loadedSessions : { ...state.loadedSessions, [id]: true },
          pageCursorBySession: { ...state.pageCursorBySession, [id]: cursor },
          hasMoreBySession: { ...state.hasMoreBySession, [id]: cursor !== undefined },
          ...(usage === undefined
            ? {}
            : {
                statsBySession: { ...state.statsBySession, [id]: usage.stats },
                tokenUsageBySession: {
                  ...state.tokenUsageBySession,
                  [id]: state.viewsBySession[id]?.state.usage ?? usage.tokenUsage,
                },
                breakdownBySession: { ...state.breakdownBySession, [id]: usage.breakdown },
              }),
        };
      });
    } finally {
      if ((get().historyEpochBySession[id] ?? 0) === requestedEpoch) {
        if (before)
          set((state) => ({
            loadingOlderBySession: { ...state.loadingOlderBySession, [id]: false },
          }));
        else
          set((state) => ({
            loadingFirstBySession: { ...state.loadingFirstBySession, [id]: false },
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

  async setSessionCwd(id, cwd) {
    await window.oint.sessions.setCwd(id, cwd);
    /**
     * 就地改这一个会话的 cwd，不重拉整表。
     *
     * 与 setSessionModel 同一个手法，但**影响面更大**：cwd 决定侧栏分组（项目 / 最近）、
     * 斜杠命令的取数目录、以及模型能访问的文件根。就地改之后这三处都会因为订阅了
     * `sessions` 而重算，不必等下一次 list。
     */
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, cwd } : session,
      ),
    }));
  },

  async removeSession(id) {
    await window.oint.sessions.remove(id);
    await get().loadSessions();
    if (get().activeSessionId === id) {
      await get().setActiveSession(null);
    }
    // 会话已从磁盘消失：把它留下的每会话缓存整批清掉（消息、翻页游标、队列、作业、未决卡片），
    // 否则这些记录会一直挂在内存里，还可能与将来复用的会话 id 串味
    set((state) => ({
      messagesBySession: omitSession(state.messagesBySession, id),
      viewsBySession: omitSession(state.viewsBySession, id),
      historyEpochBySession: omitSession(state.historyEpochBySession, id),
      loadingFirstBySession: omitSession(state.loadingFirstBySession, id),
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
      jobsReconciledSessions: omitSession(state.jobsReconciledSessions, id),
      compactions: omitSession(state.compactions, id),
      pendingApprovals: state.pendingApprovals.filter((item) => item.sessionId !== id),
      pendingAsks: state.pendingAsks.filter((item) => item.sessionId !== id),
    }));
  },

  async forkSession(id, entryId) {
    const forked = await window.oint.sessions.fork(id, entryId);
    await get().loadSessions();
    await get().setActiveSession(forked.id);
  },

  async send(text, attachments) {
    let sessionId = get().activeSessionId;
    if (!sessionId) {
      await get().createSession();
      sessionId = get().activeSessionId;
    }
    if (!sessionId) return;
    /**
     * 乐观追加用户消息，不等主进程 message-added，避免输入框闪烁。
     *
     * 附件用 part 的形态画出来（`attachmentsToParts`）：缩略图取自探测时留下的帧，
     * 所以**点发送的一瞬间**就能看到自己贴的图与文件卡片，而不是等一轮 IPC 往返。
     * 这里不再把裸 base64 塞进 `dataUrl` —— 那是个真发生过的 bug：附件提取剥掉了
     * `data:` 前缀，塞进 `dataUrl` 的其实是裸 base64，`<img src>` 因此一直是坏图。
     */
    const optimistic: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      createdAt: Date.now(),
      parts: [
        ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
        ...attachmentsToParts(attachments ?? []),
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
    await window.oint.chat.send(sessionId, text, attachments, optimistic.id);
  },

  async stop() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.oint.chat.stop(sessionId);
    // 停止前把攒着的文本先落定：主进程随后不会再补发收尾全量，被丢在缓冲里就是永久缺一段
    set((state) => ({ runningBySession: { ...state.runningBySession, [sessionId]: false } }));
  },

  async queue(text, mode) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    await window.oint.chat.queue(sessionId, text, mode);
  },

  /**
   * 撤销一条还没被消费的排队消息。
   *
   * **不在这里本地删**：队列的真值来自原生 InboxDoc 视图。本地先删一次会在「那条恰好已经被 lane 取走」时造成界面与真相对不上
   *（消息其实发出去了，行却先消失了，随后事件又把它带回列表 —— 视觉上是闪一下）。
   * 所以这里只发命令，界面等事件收正；失败也**不弹错**（already_consumed / not_found
   * 都是正常竞态，见主进程的说明）。
   */
  async cancelQueued(entryId) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    try {
      await window.oint.chat.cancelQueued(sessionId, entryId);
    } catch (failure) {
      console.warn(`撤销排队消息失败：${String(failure)}`);
    }
  },

  async compact(instructions) {
    const sessionId = get().activeSessionId;
    if (!sessionId) return { ok: false, code: "failed", message: "没有活动会话" };
    /**
     * 乐观态：先写「进行中」。
     *
     * 从这一步到内核的第一个 `compaction_start` 事件之间隔着 IPC 往返与内核准入，
     * 那段时间没有任何事件 —— 不先写这一笔，用户按下 `/compact` 后会看到界面毫无反应。
     * 真值仍以内核事件为准：事件一到就覆盖它（见 applyEvent 的 compaction-* 分支）。
     */
    const startedAt = Date.now();
    set((state) => ({
      compactions: {
        ...state.compactions,
        [sessionId]: { phase: "running", reason: "manual", startedAt },
      },
    }));
    try {
      const outcome = await window.oint.chat.compact(sessionId, instructions);
      if (!outcome.ok) {
        /**
         * 被拒（lane 忙 / 没什么可压）：把乐观态收掉。
         *
         * 但**只在没有收到任何事件时**收 —— 内核可能已经受理并跑完了这一轮压缩
         * （事件先到、结果后到），此时把状态清掉会把刚出现的摘要抹掉。
         */
        set((state) => {
          const current = state.compactions[sessionId];
          if (current === undefined || current.phase !== "running") return state;
          return {
            compactions: {
              ...state.compactions,
              [sessionId]: { phase: "failed", reason: "manual", startedAt, error: outcome.message },
            },
          };
        });
      }
      return outcome;
    } catch (failure) {
      // IPC 自身失败（进程边界异常）：同样只在乐观态还没被事件覆盖时收尾
      const message = failure instanceof Error ? failure.message : String(failure);
      set((state) => {
        const current = state.compactions[sessionId];
        if (current === undefined || current.phase !== "running") return state;
        return {
          compactions: {
            ...state.compactions,
            [sessionId]: { phase: "failed", reason: "manual", startedAt, error: message },
          },
        };
      });
      return { ok: false, code: "failed", message };
    }
  },

  clearCompaction() {
    const sessionId = get().activeSessionId;
    if (!sessionId) return;
    set((state) => ({ compactions: omitSession(state.compactions, sessionId) }));
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

    await rewriteUserMessage(
      set,
      get,
      sessionId,
      plan,
      list,
      text,
      attachmentsFromParts(lastUser.parts),
    );
  },

  /**
   * 编辑用户消息：把这条替换成新文本并重跑。
   *
   * 与重新生成走同一条路径（见 planRewrite），区别只是文本来源：
   * 都是「回退到该消息的父条目 + 把用户消息重新发出」，旧回复因此不在 tip 路径上。
   *
   * **附件跟着一起重发**：编辑改的是那句话，不是「我贴给你的东西」。早先这里传的是
   * 空附件，等于用户改一个错别字就把自己附的图丢了。
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
    const target = list[index];
    const attachments = target === undefined ? [] : attachmentsFromParts(target.parts);

    await rewriteUserMessage(set, get, sessionId, plan, list, text, attachments);
  },

  applyEvent(sessionId, event) {
    if (event.type === "view") {
      const prior = get().viewsBySession[sessionId];
      const accepted = acceptViewFrame(prior, event.frame);
      if (accepted.resync) {
        void restoreNativeView(sessionId, event.frame).catch((error) =>
          console.warn("恢复会话视图失败", error),
        );
        return;
      }
      const snapshot = accepted.snapshot;
      if (!snapshot) return;
      const branchChanged =
        prior !== undefined && prior.state.conversationId !== snapshot.state.conversationId;
      const firstMount = prior === undefined;
      const hadHistoryRequest =
        get().loadedSessions[sessionId] || get().loadingFirstBySession[sessionId];
      const wasRunning = get().runningBySession[sessionId] === true;
      set((state) => ({
        viewsBySession: { ...state.viewsBySession, [sessionId]: snapshot },
        ...(firstMount || branchChanged
          ? {
              historyEpochBySession: {
                ...state.historyEpochBySession,
                [sessionId]: (state.historyEpochBySession[sessionId] ?? 0) + 1,
              },
            }
          : {}),
        ...(branchChanged
          ? {
              loadedSessions: omitSession(state.loadedSessions, sessionId),
              pageCursorBySession: omitSession(state.pageCursorBySession, sessionId),
              hasMoreBySession: omitSession(state.hasMoreBySession, sessionId),
              loadingOlderBySession: omitSession(state.loadingOlderBySession, sessionId),
              loadingFirstBySession: omitSession(state.loadingFirstBySession, sessionId),
            }
          : {}),
        messagesBySession: {
          ...state.messagesBySession,
          [sessionId]: mergeViewMessages(
            state.messagesBySession[sessionId] ?? [],
            snapshot.state,
            branchChanged,
          ),
        },
        runningBySession: { ...state.runningBySession, [sessionId]: snapshot.state.running },
        queueBySession: { ...state.queueBySession, [sessionId]: snapshot.state.queue },
        tokenUsageBySession: { ...state.tokenUsageBySession, [sessionId]: snapshot.state.usage },
        compactions: snapshot.state.compaction
          ? { ...state.compactions, [sessionId]: snapshot.state.compaction }
          : omitSession(state.compactions, sessionId),
      }));
      if (branchChanged || (firstMount && hadHistoryRequest))
        void get()
          .loadMessages(sessionId)
          .catch((error) => console.warn("重新加载分支历史失败", error));
      if (wasRunning && !snapshot.state.running && sessionId !== get().activeSessionId)
        void get()
          .loadSessions()
          .catch((error) => console.warn("刷新会话列表失败", error));
      return;
    }
    switch (event.type) {
      case "input-admitted":
        set((state) => {
          const list = state.messagesBySession[sessionId] ?? [];
          const alreadyPresent =
            event.entryId &&
            list.some(
              (message) => message.entryId === event.entryId && message.id !== event.messageId,
            );
          return {
            messagesBySession: {
              ...state.messagesBySession,
              [sessionId]: list.flatMap((message) =>
                message.id !== event.messageId
                  ? [message]
                  : event.entryId && !alreadyPresent
                    ? [{ ...message, id: event.entryId, entryId: event.entryId }]
                    : [],
              ),
            },
          };
        });
        break;
      case "input-cancelled":
        set((state) => ({
          messagesBySession: {
            ...state.messagesBySession,
            [sessionId]: (state.messagesBySession[sessionId] ?? []).filter(
              (message) => message.id !== event.messageId || message.entryId !== undefined,
            ),
          },
        }));
        break;
      case "input-failed":
        set((state) => {
          const list = state.messagesBySession[sessionId] ?? [];
          const target = event.messageId;
          const patched =
            target && list.some((message) => message.id === target)
              ? list.map((message) =>
                  message.id === target
                    ? { ...message, status: "error" as const, error: event.error }
                    : message,
                )
              : [
                  ...list,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant" as const,
                    status: "error" as const,
                    createdAt: Date.now(),
                    parts: [],
                    error: event.error,
                  },
                ];
          return { messagesBySession: { ...state.messagesBySession, [sessionId]: patched } };
        });
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
      case "session-stats":
        set((state) => ({
          statsBySession: { ...state.statsBySession, [sessionId]: event.stats },
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
   *
   * **成功之后必须标记已对账**：这一次返回的列表就是「本进程里还有哪些作业」的权威答案，
   * 里面没有的那些（进程退出后重启、或已被上限淘汰）此后不再算「还在跑」——
   * 转录里那份停在启动那一刻的快照写着 running，是重启后「一条早就结束的作业一直显示运行中」
   * 的全部原因（见 tool-presentation 的 resolveJobView）。
   * 拉失败时刻意**不标记**：一次 IPC 抖动不能把满屏历史作业判成终态。
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
        return {
          jobsBySession: { ...state.jobsBySession, [id]: [...restored.values()] },
          jobsReconciledSessions: { ...state.jobsReconciledSessions, [id]: true },
        };
      });
    } catch (error) {
      console.warn(`恢复后台作业失败：${String(error)}`);
    }
  },
}));
