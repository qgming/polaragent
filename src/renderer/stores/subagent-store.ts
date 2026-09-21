import { create } from "zustand";
import {
  ALL_THINKING_LEVELS,
  type ChatMessage,
  type ModelRef,
  type SubagentEvent,
  type SubagentRun,
  type SubagentRunStatus,
  type SubagentSource,
  type ThinkingLevel,
} from "@/shared/contracts";

/**
 * 子智能体运行记录在渲染层的唯一来源。
 *
 * **为什么把父会话的转录当作「第一来源」**：运行记录不单独建库（见 shared/contracts/subagent.ts
 * 的文件头），它挂在派发它的那次 Task 工具调用的 `details` 上。于是「应用重启后还能看到
 * 上次派了谁、干了什么、汇报了什么」这件事，只取决于父会话磁盘上的那条工具调用 ——
 * 内存里的事件流已经没了，主进程的注册表也不落盘。转录因此不是「另一种补数据的方式」，
 * 而是持久的那一份；事件流只负责「正在跑的这段时间比磁盘新」。
 * 两者的优先级固定为：**实时事件 > 转录 / runs() 拉取**（事件来自运行中的主进程，永远更新）。
 *
 * **为什么不需要 delegationId → toolCallId 的映射表**：契约规定 `delegationId` 就是
 * 那次 Task 调用的 `toolCallId`（见 shared/contracts/subagent.ts 的 SubagentRun 注释）。
 * 渲染层要「按主会话里的那个工具调用找这条运行」时可以直接对 id，少一处会对不上的
 * 中间表 —— 这里也因此把 delegationId 当行 key 用。
 *
 * 焦点（当前看的是哪一条运行）**不放在这里**：ui-store 的 `subagentPanelTarget` 已经是它的
 * 唯一出处，主会话里的工具卡与面板都要读它，再存一份就会出现两个焦点。
 * 子会话转录按需加载（childMessages），不做预取：一个父会话可能派过几十个子智能体，
 * 每个子会话的转录都不小，而用户一次只会看其中一条。
 * 另外：子智能体的子会话是隐藏会话，**不进左侧栏**（主进程的 sessions:list 已按 kind 过滤）。
 */
interface SubagentState {
  /** 对外：父会话 id → 合并后的运行列表（按 startedAt 升序，与主进程 runs() 同序） */
  runs: Record<string, SubagentRun[]>;
  /**
   * 落定行：转录推导 + runs() 拉取（两者都是磁盘 / 主进程给出的结果）。
   * 单独一层是为了让「实时事件盖过它、它自己不被实时行写脏」这条规则可以一次算清。
   */
  durableRuns: Record<string, SubagentRun[]>;
  /** 实时事件行：父会话 id → delegationId → 行；只增不减（行内的状态由主进程推进） */
  liveRuns: Record<string, Record<string, SubagentRun>>;
  /** 子会话 id → 转录（按需加载） */
  childMessages: Record<string, ChatMessage[]>;
  /** 已经发起过加载的子会话（含正在飞的）：loadChild 的幂等闸门 */
  requestedChildren: Record<string, true>;
  /**
   * 有人问过（refresh / setRunsFromTranscript）的父会话。
   * 订阅器只保留这些会话的事件：否则用户在 A 会话里开着面板时，后台 B、C 会话的委派
   * 事件会一直往 map 里堆积，而这些行没有任何人看 —— 重启后转录还是会带回它们。
   */
  watchedSessions: Record<string, true>;
  /**
   * 收到过**权威列表**（一次成功的 `subagents:runs`）的父会话。
   *
   * 主进程是唯一知道「这条委派在本进程里是否还在跑」的一方，所以这份名单是
   * 「没被确认的 running 一律不算数」这条规则的闸门。在第一次对账之前不能降级：
   * 启动瞬间转录先到、runs() 后到，提前降级会让满屏历史行先闪一下「意外终止」。
   */
  reconciledSessions: Record<string, true>;
  /** 权威列表里的 delegationId（按父会话分组）：判定一条 running 行算不算「被确认」就靠它 */
  authoritativeIds: Record<string, Record<string, true>>;

  /** 主进程 → 渲染层的事件落地点（与 chat-store.applyEvent 同一个口径，便于直接测） */
  applyEvent(sessionId: string, event: SubagentEvent): void;
  /** 从主进程拉一次某个父会话的完整运行列表（转录只有当前加载页，更早的委派要靠它） */
  refresh(sessionId: string): Promise<void>;
  /** 父会话的消息里出现 Task 系列工具调用时调用：把转录推导出来的行并进来 */
  setRunsFromTranscript(sessionId: string, messages: readonly ChatMessage[]): void;
  /** 按需载入子会话转录；重复调用（含并发）不会重复发 IPC */
  loadChild(childSessionId: string): Promise<void>;
  /** 停一次运行：只发 IPC，状态由主进程的事件带回来 */
  stop(sessionId: string, delegationId: string): Promise<void>;
}

/** 能派发 / 管理子智能体的工具（与主进程 tools.ts 的 Task 系列同名，大小写一致） */
export const SUBAGENT_TOOL_NAMES: readonly string[] = ["Task", "TaskWait", "TaskList", "TaskStop"];

const RUN_STATUSES: readonly SubagentRunStatus[] = [
  "running",
  "completed",
  "truncated",
  "failed",
  "aborted",
  "denied",
  // 进程在运行途中退出、结果未知：这是主进程对账后给出的**终态**，不是过渡态
  "interrupted",
];

const RUN_SOURCES: readonly SubagentSource[] = ["builtin", "user", "temp"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRunStatus(value: unknown): value is SubagentRunStatus {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

function isRunSource(value: unknown): value is SubagentSource {
  return typeof value === "string" && (RUN_SOURCES as readonly string[]).includes(value);
}

/** ModelRef | null：形状不对（缺 serviceId / modelId）就当没指定模型，渲染层不解析它 */
function asModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null;
  const { serviceId, modelId } = value;
  if (typeof serviceId !== "string" || typeof modelId !== "string") return null;
  return { serviceId, modelId };
}

/** 思考档位：认不出来时退回默认档（它只进系统提示，不参与这张卡片的任何判断） */
function asThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : "medium";
}

/**
 * details / artifact → 运行记录。
 *
 * 判定依据就是契约里那对 id：`delegationId`（= 派发它的 Task 调用 id）与 `childSessionId`
 *（承载转录的隐藏会话）。缺一个都不是运行记录，返回 null 让调用方退回普通工具卡。
 * status / agentSource 取不到合法值也返回 null：面板的状态徽标与来源徽标是**穷举**映射，
 * 编一个默认值（比如当成 running）会把「记录坏了」显示成「还在跑」，比不显示更糟。
 * 其余字段缺失时给中性默认值：它们只影响卡片上的细节文案，不值得为一条旧记录丢掉整行。
 */
export function parseSubagentRun(value: unknown): SubagentRun | null {
  if (!isRecord(value)) return null;

  const { delegationId, childSessionId, status, agentSource, endedAt, updatedAt, resumedFrom } =
    value;
  const { report, error } = value;
  if (typeof delegationId !== "string" || delegationId === "") return null;
  if (typeof childSessionId !== "string" || childSessionId === "") return null;
  if (!isRunStatus(status)) return null;
  if (!isRunSource(agentSource)) return null;

  return {
    delegationId,
    sessionId: asString(value.sessionId, ""),
    parentToolCallId: asString(value.parentToolCallId, delegationId),
    childSessionId,
    agentName: asString(value.agentName, ""),
    agentSource,
    description: asString(value.description, ""),
    task: asString(value.task, ""),
    status,
    startedAt: asNumber(value.startedAt, 0),
    ...(typeof endedAt === "number" && Number.isFinite(endedAt) ? { endedAt } : {}),
    // updatedAt = 最后一次持久化的时刻（「最后被看见活着」）；resumedFrom = 这条运行接手的那次委派
    ...(typeof updatedAt === "number" && Number.isFinite(updatedAt) ? { updatedAt } : {}),
    ...(typeof resumedFrom === "string" && resumedFrom !== "" ? { resumedFrom } : {}),
    model: asModelRef(value.model),
    modelId: asString(value.modelId, ""),
    thinkingLevel: asThinkingLevel(value.thinkingLevel),
    tools: asStringArray(value.tools),
    turns: asNumber(value.turns, 0),
    toolCalls: asNumber(value.toolCalls, 0),
    ...(typeof report === "string" && report !== "" ? { report } : {}),
    ...(typeof error === "string" && error !== "" ? { error } : {}),
  };
}

/**
 * 一批运行记录：TaskWait / TaskList / TaskStop 的 details 是 `{ runs: [...] }`，
 * 而不是像 Task 那样直接给一条（见契约的 SubagentRunsDetails）。
 *
 * 逐条走同一个 parseSubagentRun：坏掉的条目被丢掉而不是让整批解析失败 ——
 * 「等了三个、其中一条记录坏了」应当仍然显示另外两条，而不是整张卡消失。
 */
export function subagentRunsFromDetails(value: unknown): SubagentRun[] | null {
  if (!isRecord(value) || !Array.isArray(value.runs)) return null;
  const runs: SubagentRun[] = [];
  for (const item of value.runs) {
    const run = parseSubagentRun(item);
    if (run !== null) runs.push(run);
  }
  return runs;
}

/** 工具参数里的一级字符串字段（Task 的 task / description 在参数上，运行记录在 details 上） */
function argString(args: unknown, key: string): string {
  return isRecord(args) && typeof args[key] === "string" ? args[key] : "";
}

/**
 * 父会话消息 → 运行行。
 *
 * 只看 Task 系列工具调用的 `details`（重启后唯一的持久来源），并用**参数**补齐
 * task / description：详情由主进程在收尾时写，而这两句在调用一开始的 arguments 里就有，
 * 缺了的话面板的「任务」区会是空的。同一条调用在多条消息里重复时按 delegationId 去重。
 */
export function subagentRunsFromMessages(
  sessionId: string,
  messages: readonly ChatMessage[],
): SubagentRun[] {
  const byId = new Map<string, SubagentRun>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      if (!SUBAGENT_TOOL_NAMES.includes(part.toolName)) continue;
      const run = parseSubagentRun(part.details);
      if (run === null) continue;

      const description =
        run.description !== "" ? run.description : argString(part.args, "description");
      const task = run.task !== "" ? run.task : argString(part.args, "task");
      byId.set(run.delegationId, {
        ...run,
        // 行里没写父会话时用调用方给的（runs 的键必须和行的归属一致，否则面板选不中它）
        sessionId: run.sessionId !== "" ? run.sessionId : sessionId,
        description,
        task,
      });
    }
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 同一 delegationId 的两行谁更可信（rank 越大越可信）：
 *   2 = 终态（含 interrupted：它已经不在跑了）
 *   1 = 运行中且已有轮次
 *   0 = 运行中但一轮都还没有
 *
 * 为什么不再用「有没有 endedAt」当判据：denied 这种起不来的终态本来就没有 endedAt，
 * 只认 endedAt 会让一条陈旧的 running 行把它盖回去；反过来，转录里的 details 可能
 * 停在派发那一刻（turns: 0），而权威列表带回来的是主进程的真实进度 —— 轮次只增不减，
 * 取大的那个既不会倒退也不会编数。同级取新到的那行（转录 / 权威列表都比旧副本新）。
 */
function durableRank(run: SubagentRun): number {
  if (run.status !== "running") return 2;
  return run.turns > 0 ? 1 : 0;
}

/** 终态（含 interrupted）不被「还在跑」的行盖掉：转录在流式期间会反复写同一条，而终态只出现一次 */
export function preferDurable(existing: SubagentRun, incoming: SubagentRun): SubagentRun {
  return durableRank(incoming) >= durableRank(existing) ? incoming : existing;
}

/** 两次推导出的行是否同一个形状：相同就保留旧引用，避免流式期间每个 token 都换数组 */
function sameRun(a: SubagentRun, b: SubagentRun): boolean {
  return (
    a.delegationId === b.delegationId &&
    a.sessionId === b.sessionId &&
    a.parentToolCallId === b.parentToolCallId &&
    a.childSessionId === b.childSessionId &&
    a.agentName === b.agentName &&
    a.agentSource === b.agentSource &&
    a.description === b.description &&
    a.task === b.task &&
    a.status === b.status &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt &&
    a.updatedAt === b.updatedAt &&
    a.resumedFrom === b.resumedFrom &&
    a.modelId === b.modelId &&
    a.thinkingLevel === b.thinkingLevel &&
    a.turns === b.turns &&
    a.toolCalls === b.toolCalls &&
    a.report === b.report &&
    a.error === b.error &&
    a.tools.length === b.tools.length &&
    a.tools.every((tool, index) => tool === b.tools[index])
  );
}

/**
 * 把一批落定行并进已有列表；没有任何变化时返回**原数组**（引用相等），
 * 调用侧据此跳过整次 set —— 转录每收到一个流式 part 都会走到这里。
 */
function mergeDurable(existing: SubagentRun[], incoming: readonly SubagentRun[]): SubagentRun[] {
  const byId = new Map(existing.map((run) => [run.delegationId, run]));
  let changed = false;
  for (const run of incoming) {
    const current = byId.get(run.delegationId);
    if (current === undefined) {
      byId.set(run.delegationId, run);
      changed = true;
      continue;
    }
    const next = preferDurable(current, run);
    if (sameRun(current, next)) continue;
    byId.set(run.delegationId, next);
    changed = true;
  }
  if (!changed) return existing;
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** 实时行盖过落定行后按 startedAt 升序（契约里 runs() 就是这个顺序，面板列表直接沿用） */
function mergeRuns(
  durable: readonly SubagentRun[],
  live: Record<string, SubagentRun> | undefined,
): SubagentRun[] {
  const byId = new Map(durable.map((run) => [run.delegationId, run]));
  if (live !== undefined) {
    for (const run of Object.values(live)) byId.set(run.delegationId, run);
  }
  return [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * 没被权威列表确认过的「运行中」→ 意外终止。
 *
 * 主进程是唯一知道「这条委派在本进程里是否还在跑」的一方：重启后转录里的旧记录还写着
 * running，而子会话索引里已经找不到它了 —— 连去问一声都做不到（索引条目没了，
 * 没有可以核对的活会话）。「确认不了它在跑」只能显示成「不知道」，
 * 绝不能显示成「还在跑」：否则每次重启都会留下一批永远转圈、永远 0 轮的幽灵行。
 *
 * endedAt 取 updatedAt（最后一次持久化 = 最后活着的时间）→ startedAt：让耗时冻结在
 * 「最后被看见」那一刻，而不是从 now 现算（见 tool-presentation 的 subagentElapsedMs）。
 */
function downgradeUnconfirmed(
  run: SubagentRun,
  confirmed: Record<string, true> | undefined,
): SubagentRun {
  if (run.status !== "running") return run;
  if (confirmed?.[run.delegationId] === true) return run;
  return {
    ...run,
    status: "interrupted",
    endedAt: run.endedAt ?? run.updatedAt ?? run.startedAt,
  };
}

/**
 * 落定行 → 对外行：先按权威名单降级，再让实时事件行盖上来。
 *
 * `confirmed === undefined`（这个会话还没成功对过账）时原样返回 —— 启动那一瞬间转录先到、
 * runs() 还在飞，此时把每一行都判成意外终止只会闪一屏假警报。实时行不参与降级：
 * 它来自本进程的事件流，是「正在跑」的第一手证据。
 */
function mergeDisplayed(
  durable: readonly SubagentRun[],
  live: Record<string, SubagentRun> | undefined,
  confirmed: Record<string, true> | undefined,
): SubagentRun[] {
  if (confirmed === undefined) return mergeRuns(durable, live);
  return mergeRuns(
    durable.map((run) => downgradeUnconfirmed(run, confirmed)),
    live,
  );
}

/** 这个会话的权威 id 名单；没对过账就是 undefined（= 不做任何降级） */
function confirmedIdsOf(state: SubagentState, sessionId: string): Record<string, true> | undefined {
  return state.reconciledSessions[sessionId] === true
    ? state.authoritativeIds[sessionId]
    : undefined;
}

/** 权威列表 → id 集合：判「这条 running 行被确认了吗」只需要 id */
function authoritativeIdSet(runs: readonly SubagentRun[]): Record<string, true> {
  const ids: Record<string, true> = {};
  for (const run of runs) ids[run.delegationId] = true;
  return ids;
}

export const useSubagentStore = create<SubagentState>()((set, get) => {
  /**
   * refresh 的在飞闸门：同一会话已有一次 `subagents:runs` 在飞就复用它。
   *
   * 多个调用方（主会话 pill、右侧面板、切会话）都可能同时来要同一份权威列表；
   * 不合并的话一次挂载就会连着发好几条 IPC，而它们要的是同一份数据。
   */
  const refreshInFlight = new Map<string, Promise<void>>();

  /** 写入落定行并重算对外行；没有变化就完全不碰 state */
  const putDurable = (sessionId: string, incoming: readonly SubagentRun[]): void => {
    set((state) => {
      const durable = mergeDurable(state.durableRuns[sessionId] ?? [], incoming);
      if (durable === state.durableRuns[sessionId]) return state;
      return {
        durableRuns: { ...state.durableRuns, [sessionId]: durable },
        runs: {
          ...state.runs,
          [sessionId]: mergeDisplayed(
            durable,
            state.liveRuns[sessionId],
            confirmedIdsOf(state, sessionId),
          ),
        },
      };
    });
  };

  const watch = (sessionId: string): void => {
    set((state) => ({ watchedSessions: { ...state.watchedSessions, [sessionId]: true } }));
  };

  /**
   * 拉一次权威列表并落进 store（refresh 的实际实现；去重闸门见 refresh）。
   */
  const refreshOnce = async (sessionId: string): Promise<void> => {
    watch(sessionId);
    let list: SubagentRun[];
    try {
      list = await window.oint.subagents.runs(sessionId);
    } catch {
      // 拉不到就保持现状：转录那一路仍然可用（面板至少显示转录里有的行），
      // 而在这里抛错只会变成调用方 effect 的 unhandled rejection。
      // 关键：**不标记已对账** —— 一次 IPC 抖动不能把满屏 running 行判成意外终止
      return;
    }
    /**
     * runs() 是主进程的权威快照：它既进落定层（与转录走同一条「不降级终态」的合并规则），
     * 又给出「哪些 running 是真的」这份名单 —— 名单之外还写着 running 的行只是重启后的残影，
     * 到这一步才会被降级成意外终止（见 mergeDisplayed）。
     */
    set((state) => {
      const durable = mergeDurable(state.durableRuns[sessionId] ?? [], list);
      const authoritativeIds = {
        ...state.authoritativeIds,
        [sessionId]: authoritativeIdSet(list),
      };
      return {
        durableRuns: { ...state.durableRuns, [sessionId]: durable },
        authoritativeIds,
        reconciledSessions: { ...state.reconciledSessions, [sessionId]: true },
        runs: {
          ...state.runs,
          [sessionId]: mergeDisplayed(
            durable,
            state.liveRuns[sessionId],
            authoritativeIds[sessionId],
          ),
        },
      };
    });
    for (const run of list) void get().loadChild(run.childSessionId);
  };

  return {
    runs: {},
    durableRuns: {},
    liveRuns: {},
    childMessages: {},
    requestedChildren: {},
    watchedSessions: {},
    reconciledSessions: {},
    authoritativeIds: {},

    applyEvent(sessionId, event) {
      // 事件信封的 sessionId 是**父**会话（见 SubagentEventEnvelope），行也放在父会话下。
      // 行自己的 sessionId 不做校验：那是同一份契约里的冗余字段，主进程写错时宁可显示在
      // 父会话下，也不要悄悄把整条运行丢掉。
      if (get().watchedSessions[sessionId] !== true) return;
      const run = event.run;
      set((state) => {
        const live = { ...(state.liveRuns[sessionId] ?? {}), [run.delegationId]: run };
        return {
          liveRuns: { ...state.liveRuns, [sessionId]: live },
          runs: {
            ...state.runs,
            // 实时行不参与降级：它来自本进程的事件流，是「正在跑」的第一手证据
            [sessionId]: mergeDisplayed(
              state.durableRuns[sessionId] ?? [],
              live,
              confirmedIdsOf(state, sessionId),
            ),
          },
        };
      });
      // 子会话转录既是嵌套消息（assistant-ui 的 ToolCallMessagePart.messages）也是面板转录区
      // 的数据源：事件一到就按需拉一次，卡片才有东西可嵌套。loadChild 幂等，重复调用免费。
      void get().loadChild(run.childSessionId);
    },

    refresh(sessionId) {
      // 同一会话已有一次在飞：复用那一次（调用方 await 的都是同一份权威列表）
      const inFlight = refreshInFlight.get(sessionId);
      if (inFlight !== undefined) return inFlight;
      const task = (async () => {
        try {
          await refreshOnce(sessionId);
        } finally {
          refreshInFlight.delete(sessionId);
        }
      })();
      refreshInFlight.set(sessionId, task);
      return task;
    },

    setRunsFromTranscript(sessionId, messages) {
      watch(sessionId);
      const derived = subagentRunsFromMessages(sessionId, messages);
      putDurable(sessionId, derived);
      // Task 卡片一出现就把子会话转录拉进来：assistant-ui 的嵌套 messages 要靠它才会成形
      for (const run of derived) void get().loadChild(run.childSessionId);
    },

    async loadChild(childSessionId) {
      const state = get();
      /**
       * 幂等闸门：`requestedChildren` 防并发重复请求，`childMessages` 已有的不再拉。
       *
       * ⚠️ **这不是实时数据源**。它的内容来自一次 `sessions:load-messages`（读磁盘），
       * 而磁盘上内核只在**一轮结束时**提交助手条目 —— 所以它最多给出「轮次粒度」的快照，
       * 而且是**调用那一刻**的快照。
       *
       * 实时转录走的是另一条路：子会话的 `chat:event` 与主会话同一条通路
       * （runtime.ts 用**子**会话 id 发事件，chat-store.applyEvent 不按会话过滤），
       * 所以 `chat-store.messagesBySession[childSessionId]` 里**已经有 token 级的实时消息**。
       * 面板优先读那一份（见 SubagentPanel 的 liveMessages），本函数只负责：
       *   · 冷启动 / 重启后补齐历史（那时内存里没有事件）；
       *   · 终态后的权威快照。
       *
       * 历史注意：这里曾经是「拿到 `[]` 就永久闩死」，导致启动竞态下
       * （runner 先 publish 再 send，读到的子会话还没有消息）详情永远空白 ——
       * 那正是「有轮次与工具次数、却没有会话内容」这个缺陷的一半原因。
       */
      if (state.childMessages[childSessionId] !== undefined) return;
      if (state.requestedChildren[childSessionId] === true) return;
      set((current) => ({
        requestedChildren: { ...current.requestedChildren, [childSessionId]: true },
      }));
      try {
        const page = await window.oint.sessions.loadMessages(childSessionId);
        set((current) => ({
          childMessages: { ...current.childMessages, [childSessionId]: page.messages },
        }));
      } catch {
        // 失败就放下闸门：下次（例如重新点开这条运行）还能再试一次
        set((current) => {
          const next = { ...current.requestedChildren };
          delete next[childSessionId];
          return { requestedChildren: next };
        });
      }
    },

    async stop(sessionId, delegationId) {
      // 刻意不做乐观更新：把行改成 aborted 之后如果主进程拒绝（子会话已经不在了），
      // 面板会一直显示「已停止」而它其实还在跑。真正的状态由主进程的事件带回来。
      // 调用方（面板的停止按钮）负责接住抛错并说明原因。
      await window.oint.subagents.stop(sessionId, delegationId);
    },
  };
});

/** 事件订阅的模块级闸门：见 subscribeSubagentEvents */
let eventSubscriptionAttached = false;

/**
 * 把 subagents 事件流接进 store（幂等，只有第一次真的挂监听）。
 *
 * 幂等在**模块级**而不是组件里：订阅的生命周期是「整个渲染进程」。挂在组件里会在卸载时
 * 断掉，而正在跑的委派不会因为用户切了视图就停 —— 断掉之后只能等下一次事件才恢复，
 * 中间这段状态变化就丢了。返回的取消函数因此也刻意不用：没有一条比进程更长的生命周期。
 */
export function subscribeSubagentEvents(): void {
  if (eventSubscriptionAttached) return;
  eventSubscriptionAttached = true;
  window.oint.subagents.onEvent((envelope) => {
    useSubagentStore.getState().applyEvent(envelope.sessionId, envelope.event);
  });
}
