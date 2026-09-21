// 子智能体运行管理器：本进程内所有子智能体运行的唯一持有者。
//
// 运行记录**既在内存里，也在盘上**：
//   1. 内存（liveRuns / liveByChild）是「本进程派出去、还在推进」的运行 —— 只有它能被等待、被停止；
//   2. 每次运行同时落在**它自己那个子会话的索引条目**上（session-store 的 saveSubagentRun）：
//      父会话转录里那次 Task 调用的 `details` 只在派发时写一次、此后无法更新，
//      重启后只有子会话条目还能被后来的进程寻址；
//   3. 子智能体的转录仍留在它的隐藏子会话里（kind: "subagent"）。
// 于是「进程在上一次运行期间没了」这件事才看得出来：盘上还写着 running，
// 而本进程的 liveRuns 里没有它 —— reconcileSubagentRuns 把这种孤儿标成 interrupted（结果未知），
// 要不要重派交给主代理判断（见 tools/subagent.ts 的 resumeOf）。
//
// 状态推进一律经过 finish()：先把终态写进记录、再唤醒等待者、最后发事件（终态还要再落一次盘）——
// 保证渲染层收到的**最后一条** run-updated 事件带的就是终态，不需要再补一次查询。
//
// 与 runtime 的分工：会话怎么建、prompt 怎么发、审批挂在哪，都问 runtime（registerSubagentSession /
// getChatRuntime）；本模块只维护「一次委派的生命周期」：起会话、记进度、判终态、等收敛、停掉。

import type { ThinkingLevel } from "@/shared/contracts/common";
import type { SessionCreateOptions } from "@/shared/contracts/session";
import {
  isSubagentRunFinished,
  MAX_CONCURRENT_SUBAGENT_RUNS,
  type SubagentEventEnvelope,
  type SubagentRun,
  type SubagentRunFinishedStatus,
} from "@/shared/contracts/subagent";
import { errorText } from "./error-text";
import { getChatRuntime, registerSubagentSession } from "./runtime";
import { getSessionStore } from "./session-store";
import {
  normalizeSubagentTools,
  type SubagentSlotHolder,
  type SubagentSlotReservation,
  type SubagentStartRequest,
} from "./tools/subagent";

/** 子会话标题里描述部分的上限（连同名字一起，别把侧栏刚展开的一行撑爆） */
const MAX_TITLE_CHARS = 60;
/** 等收敛时的轮询间隔上限：既保证 settle 一到就醒，又不会因为一次等待把定时器堆成一片 */
const WAIT_POLL_MS = 2_000;

/**
 * 派发这次运行的父会话信息（由 runtime 的 createSubagentTools 装配时给出）。
 *
 * 为什么不从会话索引里读：父会话的「当前模型 / 思考档位」是运行时状态（用户可能刚热切换过），
 * 而且子智能体要继承的正是**主会话现在用的那个**，不是设置里的默认值。
 */
export interface SubagentRunnerParent {
  /** 父（主）会话 id：运行记录挂在它下面，审批也回它 */
  sessionId: string;
  /** 父会话工作目录：子会话继承 */
  cwd: string;
  /** 父会话当前模型 id：定义里没固定模型时显示「继承主会话」 */
  parentModelId: string;
  /**
   * 父会话当前实际的思考档位。
   *
   * 只用于**记录与显示**：定义里没写 thinkingLevel 时，面板要显示子智能体继承到了哪一档。
   * 真正生效的档位由 runtime 按同一份定义在子会话创建时算出来（同源，不会两处不一致）。
   */
  parentThinkingLevel?: ThinkingLevel;
}

/** 进程内一次的运行：记录 + 收敛信号 */
interface LiveRun {
  run: SubagentRun;
  /** TaskWait 的收敛信号：进入终态时 resolve（同一个 promise，多个等待者共享） */
  settled: Promise<void>;
  settle: () => void;
  /** 是否已进终态：终态只写一次（截断后 abort 的 run_end 不能把状态改回去） */
  finished: boolean;
}

/** 全部运行，按 delegationId 索引（== 派发它的那次 Task 调用的 id，见契约） */
const liveRuns = new Map<string, LiveRun>();
/** 子会话 id → 运行：进度上报（message_end / tool_end / run_end）按会话 id 进来，需要 O(1) 找到它 */
const liveByChild = new Map<string, LiveRun>();

/** 主进程 → 渲染进程的运行事件出口；由 createChatRuntime 注入（见 setSubagentEmitter） */
let emitter: ((envelope: SubagentEventEnvelope) => void) | null = null;

/**
 * 注入事件出口。
 *
 * 为什么不直接用 runtime 的 deps.emit：那个出口固定发在 IPC.chat.event 上，事件语义是「会话转录」；
 * 而运行记录属于**父会话**的委派面板，走的是 IPC.subagents.event（契约见 ipc.ts 的 subagents.event）。
 * 传 null 可以取消（测试 / 释放）。
 */
export function setSubagentEmitter(fn: ((envelope: SubagentEventEnvelope) => void) | null): void {
  emitter = fn;
}

/**
 * 并发名额的**预约**：同一条消息里的多个 Task 是并发执行的，
 * 「先数一遍在跑的、再启动」之间没有任何互斥 —— 每个 execute 都只看到「自己开始时」的
 * 运行数，于是同批发 5 个能全部通过（实测如此），而顺序发第 5 个会被正确拒绝。
 *
 * 为什么占位要放在 runner 而不是工具层：名额的真相是「谁在跑」，那份状态本来就归本模块
 * （liveRuns）。工具层只做一次同步的 tryReserve，不自己维护第二份计数 ——
 * 两份计数必然漂移，而漂移的表现就是「上限时而生效时而不生效」。
 *
 * 为什么必须是同步的：竞态窗口正是 `await`（`await deps.list()` 与 `await deps.start()` 之间）。
 * 预约与释放都不经过 await，这一段就不会被别的 execute 穿插。
 */
interface SlotReservation {
  sessionId: string;
  agentName: string;
}
const slotReservations = new Map<string, SlotReservation>();

/**
 * 尝试占一个名额。失败时把**占位者**一并返回（已经跑起来的 + 同一批里还在启动中的）：
 * 只说一句「超上限」模型不知道该等谁，拒绝文案要能指名道姓。
 */
export function reserveSubagentSlot(
  sessionId: string,
  delegationId: string,
  agentName: string,
): SubagentSlotReservation {
  const holders = subagentSlotHolders(sessionId);
  if (holders.length >= MAX_CONCURRENT_SUBAGENT_RUNS) return { ok: false, holders };
  slotReservations.set(delegationId, { sessionId, agentName });
  return { ok: true };
}

/** 归还名额：启动失败（抛错 / denied）时必须调用，否则名额会永久泄漏 */
export function releaseSubagentSlot(delegationId: string): void {
  slotReservations.delete(delegationId);
}

/**
 * 某个父会话当前的名额占位者：在跑的运行 + 同一批里已预约、还没跑起来的。
 *
 * 判据是「**现在还在跑**」，不是「历史上记过多少条」：终态的运行不再占名额，
 * 否则跑完的委派会一直挂着，上限迟早被历史记录填满（表现为「没人在跑却一直说超上限」）。
 * 运行是否终态以契约的 isSubagentRunFinished 为准（与面板 / TaskList 对状态的判定同源）。
 *
 * 按 delegationId 去重：同一次运行在「预约」与 liveRuns 里可能各出现一次
 *（预约覆盖到运行登记之间的窗口），各数一遍会让上限提前触发、拒绝文案里的计数也对不上。
 */
export function subagentSlotHolders(sessionId: string): SubagentSlotHolder[] {
  const holders = new Map<string, SubagentSlotHolder>();
  for (const entry of liveRuns.values()) {
    if (entry.run.sessionId !== sessionId || isSubagentRunFinished(entry.run.status)) continue;
    holders.set(entry.run.delegationId, {
      delegationId: entry.run.delegationId,
      agentName: entry.run.agentName,
    });
  }
  for (const [delegationId, reservation] of slotReservations) {
    if (reservation.sessionId !== sessionId || holders.has(delegationId)) continue;
    holders.set(delegationId, { delegationId, agentName: reservation.agentName });
  }
  return [...holders.values()];
}

/** 发出去的必须是快照：运行记录还会被继续改，活对象交给 IPC 之后拿到什么全看时机 */
function snapshot(run: SubagentRun): SubagentRun {
  return { ...run, tools: [...run.tools] };
}

/**
 * 落一次盘（fire-and-forget）。
 *
 * 为什么不能 await：运行记录是「给下一个进程看的账」，不是这次调用的结果 ——
 * 索引被占用、磁盘满都不该让一次运行失败（记录丢了顶多面板少一行，运行本身不能因此中断）。
 * 每次写进去的必须是**当前快照**：活对象还会继续被改，直接交给 store 的话落盘的可能是写之前 / 之后的样子。
 */
function persist(run: SubagentRun): void {
  run.updatedAt = Date.now();
  const record = snapshot(run);
  try {
    void getSessionStore()
      .saveSubagentRun(run.childSessionId, record)
      .catch((error: unknown) => {
        console.warn(`保存子智能体运行记录失败（${run.delegationId}）：${errorText(error)}`);
      });
  } catch (error) {
    console.warn(`保存子智能体运行记录失败（${run.delegationId}）：${errorText(error)}`);
  }
}

/**
 * 推一条 run-updated 给渲染层。
 *
 * 信封里的 sessionId 是**父**会话：渲染层按当前打开的会话过滤，子会话是隐藏会话，
 * 不该也不会为它维护一套流式状态（run 记录本身带 childSessionId，需要时再点进去看转录）。
 *
 * 事件发不出去（没有 emitter、窗口已关、IPC 抛错）不影响运行本身：记录仍在内存与索引里，
 * 渲染层还能通过 TaskList 或那次 Task 调用的 details 拿到同样的数据。
 */
function publish(run: SubagentRun): void {
  const target = emitter;
  if (target === null) return;
  const record = snapshot(run);
  try {
    target({ sessionId: record.sessionId, event: { type: "run-updated", run: record } });
  } catch (error) {
    console.warn(`发送子智能体运行事件失败（${record.delegationId}）：${errorText(error)}`);
  }
}

/**
 * 写终态。返回是否真的写入（已经终态时返回 false，调用方据此决定要不要再发事件）。
 *
 * 只写一次是为了让「先到者为准」成立：截断（turns 超上限）会先落 truncated 再 abort，
 * 随后到达的 run_end（aborted）不能把它改回去 —— 否则面板会丢掉「报告可能不完整」这条关键信息。
 *
 * 传入的 status 也就是**落盘**的 status：对账要写的 interrupted 走的是同一条落盘路径
 * （reconcileSubagentRuns 里那个没有活对象的孤儿不是「本进程的运行」，不经过这里）。
 */
function finish(entry: LiveRun, status: SubagentRunFinishedStatus, error?: string): boolean {
  if (entry.finished) return false;
  entry.finished = true;
  entry.run.status = status;
  entry.run.endedAt = Date.now();
  if (error !== undefined && error !== "") entry.run.error = error;
  // 进度上报只对「还在跑」的运行有意义，终态后不再按会话 id 找它
  liveByChild.delete(entry.run.childSessionId);
  entry.settle();
  // 终态必须最后落盘：此前每一次写下的都是「还在跑」，这一次之后重启读到的才是结论
  persist(entry.run);
  // 报告投递放在收尾的最后：状态与报告都已定稿，投出去的才是结论
  deliverReport(entry);
  return true;
}

/**
 * 子智能体到达终态：把结果交回去（组装规则见 report-delivery.ts）。
 *
 * 为什么挂在这里而不是工具层：`finish()` 是**所有**终止路径的唯一收敛点
 * （正常跑完、失败、被主代理停、被新指令中止、被重复守卫终止、起不来）。
 * 挂在工具层就只覆盖「模型恰好调了 TaskWait」的那一半 —— 而报告丢失正是这么发生的。
 *
 * 「交回去」的口径是 **runtime 把结果回填到那次 Task 调用的 part 上**：
 * 用户看到的是「子智能体已完成」这个状态里的报告，而不是凭空多一条消息
 *（形状的取舍见 report-delivery.ts 的文件头）。
 *
 * 幂等由 `finish()` 保证：已经终态时它直接返回 false，本函数因此不会重复执行。
 * 异常一律吞掉：这条路径在 harness 事件回调与工具处理器里都被调用，
 * 一次回填失败不该让运行收尾或工具调用跟着炸。
 */
function deliverReport(entry: LiveRun): void {
  try {
    getChatRuntime().deliverSubagentReport(snapshot(entry.run));
  } catch (error) {
    console.warn(`回填子智能体结果失败（${entry.run.delegationId}）：${errorText(error)}`);
  }
}

/** 子会话标题：`名字 · 描述`，超长截断（标题就是「已命名」标记，自动命名不会再来覆盖它） */
function sessionTitle(name: string, description: string): string {
  const label = `${name} · ${description}`.replace(/\s+/g, " ").trim();
  const chars = Array.from(label);
  if (chars.length <= MAX_TITLE_CHARS) return label;
  return `${chars.slice(0, MAX_TITLE_CHARS - 1).join("")}…`;
}

/** 停掉子会话里正在跑的那一轮；失败只记日志（调用方已经在做终态收尾，不该被 abort 的异常打断） */
async function stopChildRun(entry: LiveRun): Promise<void> {
  try {
    await getChatRuntime().stop(entry.run.childSessionId);
  } catch (error) {
    console.warn(`停止子智能体会话失败（${entry.run.childSessionId}）：${errorText(error)}`);
  }
}

/**
 * 发第一条消息：**不 await 完成** —— `send` 直到这一轮运行结束才 resolve，
 * 而 Task 工具必须立刻拿到运行记录返回（fire-and-forget 语义见 tools/subagent.ts 的文案）。
 *
 * 起不来（没配模型、会话打不开…）时标 denied：与「跑起来了但失败了」区分开，
 * 主模型据此可以换个做法重派，而不是去 TaskWait 一个从来没开始的运行。
 */
async function startChildRun(entry: LiveRun): Promise<void> {
  try {
    await getChatRuntime().send(entry.run.childSessionId, entry.run.task);
  } catch (error) {
    // 名额在这里就该还：这个运行从未真正跑起来，占着名额只会让「重派」被自己的失败卡住。
    // （预约是工具层下的，所以归还也只能在这里做 —— 工具层此刻已经在等 start 返回了。）
    releaseSubagentSlot(entry.run.delegationId);
    if (finish(entry, "denied", errorText(error))) publish(entry.run);
  }
}

/**
 * 启动一次委派。
 *
 * 顺序不能变：**先建子会话 → 再登记 spec → 最后才发消息**。runtime 打开会话时读 spec 决定
 * 工具子集 / 系统提示 / 模型档位，登记晚了它就会按主会话的样子装配（子智能体会拿到全部工具）。
 *
 * 返回的是**刚启动时**的记录（status: "running"、计数为 0）：后续状态靠 run-updated 事件推进，
 * 主模型要结果就去 TaskWait。这条路也是「记录能活过进程」的起点：登记之后立刻落一次盘，
 * 从那以后盘上就一直有这条运行（见 header 的对账说明）。
 *
 * 名额预约（reserveSubagentSlot）由工具层在调用这里**之前**完成：那段必须是同步的（见那边的注释），
 * 而这里第一个动作就是 `await`（建子会话）—— 预约若放在本函数里，竞态窗口照样存在。
 * 于是本函数负责的是**归还**：中途抛错时名额不能留下（否则失败几次就把上限永久占满）。
 */
export async function startSubagentRun(
  request: SubagentStartRequest,
  parent: SubagentRunnerParent,
): Promise<SubagentRun> {
  try {
    return await startReservedRun(request, parent);
  } catch (error) {
    // 名额是工具层预约的；这里抛错（建会话失败、登记失败）时名额不能留下 ——
    // 否则失败几次就把上限永久占满，而表现是「明明没人在跑，却一直说超上限」
    releaseSubagentSlot(request.toolCallId);
    throw error;
  }
}

/** 预约之后真正建会话并启动；失败由调用方（startSubagentRun）归还名额 */
async function startReservedRun(
  request: SubagentStartRequest,
  parent: SubagentRunnerParent,
): Promise<SubagentRun> {
  const definition = request.definition;
  const tools = normalizeSubagentTools(definition.tools);
  const createOptions: SessionCreateOptions = {
    cwd: parent.cwd,
    title: sessionTitle(definition.name, request.description),
    kind: "subagent",
    parentSessionId: parent.sessionId,
    // 契约规定 delegationId === parentToolCallId：渲染层按「主会话里的那次工具调用」找运行记录，
    // 中间不再插一层映射表（少一处会对不上的地方）
    parentToolCallId: request.toolCallId,
    agentName: definition.name,
    delegationId: request.toolCallId,
  };
  const child = await getSessionStore().create(createOptions);

  const run: SubagentRun = {
    delegationId: request.toolCallId,
    sessionId: parent.sessionId,
    parentToolCallId: request.toolCallId,
    childSessionId: child.id,
    agentName: definition.name,
    agentSource: definition.source,
    description: request.description,
    task: request.task,
    status: "running",
    startedAt: Date.now(),
    // model 为 null = 继承父会话（面板据此显示「继承主会话」）
    model: definition.model ?? null,
    modelId: definition.model ? definition.model.modelId : parent.parentModelId,
    thinkingLevel: definition.thinkingLevel ?? parent.parentThinkingLevel ?? "off",
    tools,
    turns: 0,
    toolCalls: 0,
    // 重派（Task 的 resumeOf）时写下它接续的是哪一次委派；旧记录本身不动 —— 那是历史，不是要被覆盖的行
    ...(request.resumedFrom === undefined ? {} : { resumedFrom: request.resumedFrom }),
  };

  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const entry: LiveRun = { run, settled, settle, finished: false };
  liveRuns.set(run.delegationId, entry);
  /**
   * 运行一登记，预约就归还：名额从此由 liveRuns 里这条运行持有（终态时自动让出）。
   * 留着预约会让同一次运行被数两遍，而且它会一直躺在 slotReservations 里 ——
   * 哪怕运行早已结束，上限也会被这些「幽灵占位」慢慢填满（4 个跑完之后第 5 个永远派不出去）。
   */
  releaseSubagentSlot(run.delegationId);
  liveByChild.set(run.childSessionId, entry);
  registerSubagentSession(run.childSessionId, {
    definition,
    parentSessionId: parent.sessionId,
  });

  // 先落盘再发事件：渲染层收到 run-updated 时，索引里已经有这条运行了（刷新 / 重启都在）
  persist(run);
  publish(entry.run);
  void startChildRun(entry);
  return run;
}

/** 某个父会话的全部运行（按 startedAt 升序：与派发顺序一致，界面与模型的认知也不会错位） */
export function listSubagentRuns(sessionId: string): SubagentRun[] {
  return [...liveRuns.values()]
    .filter((entry) => entry.run.sessionId === sessionId)
    .map((entry) => snapshot(entry.run))
    .sort((left, right) => left.startedAt - right.startedAt);
}

/**
 * 停一次运行，返回停止后的记录。
 *
 * 未知 id（或不属于该会话）返回 undefined 而不是抛错：TaskStop 要能把「这个 id 不存在」
 * 作为一条可读结果告诉模型（写错 id 是常见的模型失误），抛错会让整次工具调用失败。
 */
export async function stopSubagentRun(
  sessionId: string,
  delegationId: string,
): Promise<SubagentRun | undefined> {
  const entry = liveRuns.get(delegationId);
  if (entry === undefined || entry.run.sessionId !== sessionId) return undefined;
  if (!entry.finished) {
    // 先落终态再 abort：abort 产生的 run_end 随后才到，不能让它把状态改回 aborted / failed
    finish(entry, "aborted", "主代理停止了这次运行");
    publish(entry.run);
    await stopChildRun(entry);
  }
  return snapshot(entry.run);
}

/**
 * 父会话又开了一轮：上一轮派出去的委派不该继续跑。
 *
 * 新指令很可能已经改了前提（用户换了方向、刚才的问题已经不成立），让它们跑完只是白烧 token，
 * 而且会在用户看得见的列表里留下与当前对话无关的运行。只对主会话调用 ——
 * 子智能体自己不会有委派（不允许嵌套）。
 */
export function abortSubagentRunsForParent(parentSessionId: string): void {
  for (const entry of liveRuns.values()) {
    if (entry.run.sessionId !== parentSessionId || entry.finished) continue;
    if (finish(entry, "aborted", "父会话开始了新一轮指令")) publish(entry.run);
    void stopChildRun(entry);
  }
}

/**
 * 父会话关闭/删除时丢掉它**在内存里**的运行记录：不再拖着定义与报告占内存，也不再为它推事件。
 *
 * 盘上那条记录不动 —— 它是这个会话的历史（重开后由 reconcileSubagentRuns 按实际情况呈现）。
 * 这里丢掉的只是「本进程还记得它」，与「它存在过」是两件事。
 */
export function forgetSubagentRuns(sessionId: string): void {
  for (const [delegationId, entry] of liveRuns) {
    if (entry.run.sessionId !== sessionId) continue;
    liveRuns.delete(delegationId);
    liveByChild.delete(entry.run.childSessionId);
  }
  // 预约也是这个会话的名额状态：正在启动窗口里的那些同样不该留下，
  // 否则会话关了它们还占着位置，之后同名 id 再来派发会被自己的旧占位挡住
  for (const [delegationId, reservation] of slotReservations) {
    if (reservation.sessionId === sessionId) slotReservations.delete(delegationId);
  }
}

/**
 * 对账：把索引里「还在跑」但本进程不认识的运行标成**意外终止**，返回合并后的完整列表。
 *
 * 为什么必须有这一步：只有写终态的那个进程知道结局。进程在它运行期间没了（崩溃、被强杀、断电），
 * 索引里留下的就是一条永远的 running —— 而推进它的人已经不在了。判据是「没有活的对应者」，
 * 不是「记录旧」：本进程派出去的运行在 liveRuns 里，永远以 live 为准（内存里那份更新）。
 *
 * 为什么在**读的时候**做而不是启动时做一次：只有有人看这个会话时这些记录才有意义，
 * 而且启动时对账会把「另一个窗口正开着的会话」也算进去，多此一举还容易读错时间点。
 */
export async function reconcileSubagentRuns(sessionId: string): Promise<SubagentRun[]> {
  const live = listSubagentRuns(sessionId);
  let persisted: SubagentRun[];
  try {
    persisted = await getSessionStore().listSubagentRunsFor(sessionId);
  } catch (error) {
    // 索引读不出来不是运行的错：本进程知道的照常返回，绝不把错误抛给面板 / 工具
    console.warn(
      `读取子智能体运行记录失败，只返回本进程的运行（${sessionId}）：${errorText(error)}`,
    );
    return live;
  }

  const liveById = new Map(live.map((run) => [run.delegationId, run]));
  const merged = [...live];
  for (const run of persisted) {
    // live 优先：同一次运行内存里那份带着最新的进度与终态，索引里的可能停在上一轮
    if (liveById.has(run.delegationId)) continue;
    // 已经写下终态的记录不动：它说的是当时真实发生的结局，不该被后来的一次读改掉
    if (run.status !== "running") {
      merged.push(run);
      continue;
    }
    // 什么时候死的无从得知，只能写「最后一次记下它还活着」的时间（updatedAt 由每次落盘刷新）
    run.status = "interrupted";
    run.endedAt = run.updatedAt ?? run.startedAt;
    persist(run);
    publish(run);
    merged.push(run);
  }
  return merged.sort((left, right) => left.startedAt - right.startedAt);
}

/** 不让等待用的定时器把进程吊住（单测 / 退出时不该因为一次 TaskWait 多活十分钟） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as { unref?: () => void };
    timer.unref?.();
  });
}

/** 等到「至少 needed 个目标收敛」或超时；超时只是返回，不抛错（等待超时不等于失败） */
async function waitForSettlement(
  delegationIds: readonly string[],
  needed: number,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1_000;
  for (;;) {
    const entries = delegationIds
      .map((id) => liveRuns.get(id))
      .filter((entry): entry is LiveRun => entry !== undefined);
    if (entries.filter((entry) => entry.finished).length >= needed) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    // settle 一到就醒（Promise.race），轮询间隔只是兜底：目标里混了未知 id 时也要能按时返回
    const pending = entries.filter((entry) => !entry.finished).map((entry) => entry.settled);
    await Promise.race([Promise.all(pending), sleep(Math.min(remaining, WAIT_POLL_MS))]);
  }
}

/**
 * 等运行收敛，返回等待结束时各目标的**最新快照**。
 *
 * 等待超时不是失败：没跑完的目标照样以 status: "running" 返回，调用方（TaskWait）据此
 * 告诉模型「还没完，先做别的，稍后再等」—— 绝不抛错，否则模型会把「等太久」误当成「运行失败」。
 */
export async function waitSubagentRuns(
  sessionId: string,
  delegationIds: string[] | undefined,
  mode: "all" | "any",
  minCompleted: number,
  timeoutSeconds: number,
): Promise<SubagentRun[]> {
  const available = listSubagentRuns(sessionId);
  const targets =
    delegationIds === undefined || delegationIds.length === 0
      ? available
      : available.filter((run) => delegationIds.includes(run.delegationId));
  if (targets.length === 0) return [];
  /**
   * 「等几个算够」：all 要全部；any 要 minCompleted 个（至少 1，且不超过目标数 ——
   * 模型写了 5 而目标只有 2 个时，等 5 个等于等到超时）。
   */
  const needed =
    mode === "any" ? Math.max(1, Math.min(minCompleted, targets.length)) : targets.length;
  await waitForSettlement(
    targets.map((run) => run.delegationId),
    needed,
    timeoutSeconds,
  );
  const ids = new Set(targets.map((run) => run.delegationId));
  return listSubagentRuns(sessionId).filter((run) => ids.has(run.delegationId));
}

/**
 * 子会话的一条助手消息结束（harness message_end）：轮次 +1，正文记作「最新报告」，并落一次盘。
 *
 * 由 runtime.ts 在既有的 message_end 处理里调用（见那边的注释：不新增第二套订阅）。
 * 报告取**最后一条**助手消息：子智能体的最终答复就是它最后说的话，
 * 中间那些带工具调用的过程消息不是给主模型看的内容。
 *
 * 落盘就选在这里：一轮 = 一次助手消息，是「有实质进展」的最小单位。
 * 按 token 或按工具调用落盘只是把同一个 JSON 反复重写，对「重启后能看出跑到哪」没有多一分信息。
 */
export function noteSubagentAssistantMessage(
  childSessionId: string,
  message: { text: string; failed: boolean },
): void {
  const entry = liveByChild.get(childSessionId);
  if (entry === undefined || entry.finished) return;
  entry.run.turns += 1;
  const text = message.text.trim();
  if (text !== "") entry.run.report = text;
  persist(entry.run);
  publish(entry.run);
}

/** 子会话的一次工具调用结束：计数 +1（进度指标，面板与 TaskList 都看它） */
export function noteSubagentToolCall(childSessionId: string): void {
  const entry = liveByChild.get(childSessionId);
  if (entry === undefined || entry.finished) return;
  entry.run.toolCalls += 1;
  // 刻意不落盘：一次工具调用只是进度里的一个计数，多写一次索引换不来多一分真相
  publish(entry.run);
}

/**
 * 子会话那一轮结束（harness run_end）：写终态。
 *
 * 状态直接沿用内核给的 `completed / aborted / failed`（见契约的 SubagentRunStatus），
 * 失败时把错误信息一并记下 —— 面板与 TaskWait 都要能说清「为什么失败」。
 */
export function noteSubagentRunEnd(
  childSessionId: string,
  outcome: { status: "completed" | "aborted" | "failed"; error?: string },
): void {
  const entry = liveByChild.get(childSessionId);
  if (entry === undefined) return;
  if (!finish(entry, outcome.status, outcome.error)) return;
  publish(entry.run);
}
