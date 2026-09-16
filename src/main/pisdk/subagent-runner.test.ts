/**
 * 子智能体运行管理器的落盘与对账测试。
 *
 * 这里不碰 SQLite，也不碰真实数据目录：session-store 与 runtime 都是整体替身
 * （会话库怎么建、prompt 怎么发是 runtime.ts 的事，本文件不验证）。
 * 钉住的是「一次运行能活过进程」这条链上的约定：
 * - 起点、每轮助手消息、终态各落一次盘，工具调用不落盘（多写一次不等于多一分真相）；
 * - 写进去的必须是**快照**，不是还会继续被改的活对象；
 * - 盘上还写着 running、本进程却没有对应运行 → 那是死掉的进程留下的孤儿，标成 interrupted；
 * - 对账绝不因为索引读不出来而抛错，也绝不广播没发生过的变化。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SUBAGENT_TOOLS,
  MAX_CONCURRENT_SUBAGENT_RUNS,
  type SubagentDefinition,
  type SubagentEventEnvelope,
  type SubagentRun,
} from "@/shared/contracts/subagent";

// mock 工厂先于 import 执行：用 hoisted 容器接住替身，模块加载期不读这些变量
const store = vi.hoisted(() => ({
  create: vi.fn(),
  saveSubagentRun: vi.fn(),
  listSubagentRunsFor: vi.fn(),
}));
const chat = vi.hoisted(() => ({
  send: vi.fn(),
  stop: vi.fn(),
  register: vi.fn(),
  deliverSubagentReport: vi.fn(),
}));

vi.mock("./session-store", () => ({ getSessionStore: () => store }));
vi.mock("./runtime", () => ({
  getChatRuntime: () => ({
    send: chat.send,
    stop: chat.stop,
    deliverSubagentReport: chat.deliverSubagentReport,
  }),
  registerSubagentSession: chat.register,
}));

import type { SubagentRunnerParent } from "./subagent-runner";
import {
  forgetSubagentRuns,
  noteSubagentAssistantMessage,
  noteSubagentRunEnd,
  noteSubagentToolCall,
  reconcileSubagentRuns,
  reserveSubagentSlot,
  setSubagentEmitter,
  startSubagentRun,
  subagentSlotHolders,
} from "./subagent-runner";

const PARENT: SubagentRunnerParent = {
  sessionId: "s-parent",
  cwd: "C:/work",
  parentModelId: "svc/model-x",
};

function definition(name = "scout"): SubagentDefinition {
  return {
    name,
    description: `${name} 的说明`,
    prompt: "你是子智能体，只做被派的那件事。",
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    source: "builtin",
  };
}

/** 一条运行记录：默认是「盘上还写着 running」的样子 */
function makeRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s-parent",
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "scout",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "看 src/retry.ts 的重试逻辑",
    status: "running",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    maxTurns: 30,
    tools: [...DEFAULT_SUBAGENT_TOOLS],
    turns: 0,
    toolCalls: 0,
    ...patch,
  };
}

/** 起一次真实运行：起点的那次落盘也在这条链上 */
async function startRun(toolCallId = "d-live"): Promise<SubagentRun> {
  return startSubagentRun(
    {
      toolCallId,
      definition: definition(),
      description: "调研重试逻辑",
      task: "看 src/retry.ts 的重试逻辑",
    },
    PARENT,
  );
}

/** 取第 index 次落盘的内容；没写过直接抛错，避免断言静默拿到 undefined */
function written(index: number): { childSessionId: string; run: SubagentRun } {
  const call = store.saveSubagentRun.mock.calls.at(index) as [string, SubagentRun] | undefined;
  if (call === undefined) throw new Error(`第 ${index} 次 saveSubagentRun 没有被调用`);
  return { childSessionId: call[0], run: call[1] };
}

/** 收集运行事件：对账该广播什么、不该广播什么都在这里看 */
function collectEvents(): SubagentEventEnvelope[] {
  const events: SubagentEventEnvelope[] = [];
  setSubagentEmitter((envelope) => events.push(envelope));
  return events;
}

beforeEach(() => {
  vi.clearAllMocks();
  // 每次 create 都给一个不同的子会话 id：进度与终态都按子会话 id 找运行，
  // 同一个 id 会让多条运行互相顶掉（名额相关的用例要能一条一条地终结）
  let childCount = 0;
  store.create.mockImplementation(async () => ({ id: `child-${++childCount}` }));
  store.saveSubagentRun.mockResolvedValue(undefined);
  store.listSubagentRunsFor.mockResolvedValue([]);
});

afterEach(() => {
  // 事件出口是模块级状态：留着会串到下一个用例（真实环境里也是「窗口关了就不该再收」）
  setSubagentEmitter(null);
  /**
   * 运行登记表同样是模块级状态，而且**不会**随 stub 的 store 重置 ——
   * 不清的话上一个用例起的 d-live 会出现在下一个用例的对账结果里
   *（「盘上只剩孤儿」那条会莫名多出一行）。真实环境里这条路径由会话关闭调用。
   */
  forgetSubagentRuns(PARENT.sessionId);
});

describe("运行记录的落盘", () => {
  it("起一次运行就落一次盘：状态 running、计数为 0、updatedAt 已写", async () => {
    const run = await startRun();

    expect(store.create).toHaveBeenCalledTimes(1);
    expect(store.saveSubagentRun).toHaveBeenCalledTimes(1);
    const first = written(0);
    expect(first.childSessionId).toBe(run.childSessionId);
    expect(first.run).toMatchObject({
      delegationId: "d-live",
      status: "running",
      turns: 0,
      toolCalls: 0,
    });
    expect(typeof first.run.updatedAt).toBe("number");
    // 写进去的必须是快照：活对象随后还会被推进，落盘那份不能跟着变
    expect(first.run).not.toBe(run);
    expect(first.run.tools).not.toBe(run.tools);
  });

  it("每轮助手消息落一次盘，工具调用不落盘，终态再落一次（最后写下的就是结论）", async () => {
    const run = await startRun();
    const child = run.childSessionId;

    noteSubagentToolCall(child);
    expect(store.saveSubagentRun).toHaveBeenCalledTimes(1); // 仍然只有起点那一次

    noteSubagentAssistantMessage(child, { text: "第一轮报告", failed: false });
    expect(store.saveSubagentRun).toHaveBeenCalledTimes(2);
    expect(written(1).run).toMatchObject({
      turns: 1,
      report: "第一轮报告",
      status: "running",
    });

    noteSubagentRunEnd(child, { status: "completed" });
    expect(store.saveSubagentRun).toHaveBeenCalledTimes(3);
    const last = written(2).run;
    expect(last.status).toBe("completed");
    expect(typeof last.endedAt).toBe("number");
  });

  it("落盘失败不影响运行本身：只记日志", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.saveSubagentRun.mockRejectedValue(new Error("索引被占用"));

    const run = await startRun();
    noteSubagentAssistantMessage(run.childSessionId, { text: "报告", failed: false });

    expect(run.status).toBe("running");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("reconcileSubagentRuns", () => {
  it("盘上还在跑、本进程不认识：标成 interrupted（endedAt = 最后一次落盘时间），落盘并广播一次", async () => {
    const events = collectEvents();
    store.listSubagentRunsFor.mockResolvedValue([
      makeRun({
        delegationId: "d-orphan",
        childSessionId: "child-orphan",
        status: "running",
        startedAt: 4_000,
        updatedAt: 5_000,
        turns: 2,
      }),
    ]);

    const runs = await reconcileSubagentRuns("s-parent");

    expect(store.listSubagentRunsFor).toHaveBeenCalledWith("s-parent");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      delegationId: "d-orphan",
      status: "interrupted",
      endedAt: 5_000,
    });
    // 降级必须写回去：只改返回值的话，下一次读还是 running，面板永远是「还在跑」
    expect(store.saveSubagentRun).toHaveBeenCalledTimes(1);
    const persisted = written(0);
    expect(persisted.childSessionId).toBe("child-orphan");
    expect(persisted.run).toMatchObject({ status: "interrupted", endedAt: 5_000 });
    // 广播一次，让开着的面板自己修正（不需要用户手动刷新）
    expect(events).toHaveLength(1);
    expect(events[0]?.sessionId).toBe("s-parent");
    expect(events[0]?.event).toMatchObject({
      type: "run-updated",
      run: { delegationId: "d-orphan", status: "interrupted" },
    });
  });

  it("盘上那条本进程还在跑：以内存为准，不重复落盘也不广播", async () => {
    const events = collectEvents();
    const run = await startRun();
    noteSubagentAssistantMessage(run.childSessionId, { text: "报告", failed: false });
    const savesSoFar = store.saveSubagentRun.mock.calls.length;
    events.length = 0;
    // 索引里那份停在上一次落盘：轮次少一轮、状态仍是 running
    store.listSubagentRunsFor.mockResolvedValue([
      makeRun({
        delegationId: "d-live",
        childSessionId: run.childSessionId,
        status: "running",
        turns: 0,
        updatedAt: 1_000,
      }),
    ]);

    const runs = await reconcileSubagentRuns("s-parent");

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ delegationId: "d-live", status: "running", turns: 1 });
    expect(store.saveSubagentRun.mock.calls.length).toBe(savesSoFar);
    expect(events).toHaveLength(0);
  });

  it("盘上已经写下终态的运行：原样返回（按 startedAt 升序），不写不广播", async () => {
    const events = collectEvents();
    store.listSubagentRunsFor.mockResolvedValue([
      makeRun({ delegationId: "d-done", startedAt: 3_000, status: "completed", endedAt: 4_000 }),
      makeRun({ delegationId: "d-aborted", startedAt: 1_000, status: "aborted", endedAt: 2_000 }),
    ]);

    const runs = await reconcileSubagentRuns("s-parent");

    expect(runs.map((run) => run.delegationId)).toEqual(["d-aborted", "d-done"]);
    expect(store.saveSubagentRun).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("索引读不出来：不抛错，退回本进程的运行（并记一条警告）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await startRun();
    store.listSubagentRunsFor.mockRejectedValue(new Error("索引文件被占用"));

    const runs = await reconcileSubagentRuns("s-parent");

    expect(runs.map((item) => item.delegationId)).toEqual(["d-live"]);
    expect(runs[0]?.childSessionId).toBe(run.childSessionId);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * 报告投递（本次修复的核心要求）：报告必须在**终态**那一刻交出去。
 *
 * 为什么不在工具层测：`finish()` 是所有终止路径的唯一收敛点。挂在 TaskWait 上就只能覆盖
 * 「模型恰好来问」的那一半 —— 而报告丢失正是这么发生的（模型没问，报告就没了）。
 */
describe("报告投递", () => {
  it("跑完并写下报告后，终态那一刻把报告交给父会话", async () => {
    const run = await startRun();
    noteSubagentAssistantMessage(run.childSessionId, { text: "重试上限是 3 次。", failed: false });

    noteSubagentRunEnd(run.childSessionId, { status: "completed" });

    expect(chat.deliverSubagentReport).toHaveBeenCalledTimes(1);
    const delivered = chat.deliverSubagentReport.mock.calls[0]?.[0] as SubagentRun;
    expect(delivered.status).toBe("completed");
    // 报告是这次修复的要害：它曾经恒为空（取文函数对助手消息返回空串）
    expect(delivered.report).toBe("重试上限是 3 次。");
    expect(delivered.delegationId).toBe(run.delegationId);
  });

  it("同一次运行只投递一次（重复的 run_end 不改写终态，也不再投一次）", async () => {
    const run = await startRun();
    noteSubagentAssistantMessage(run.childSessionId, { text: "报告", failed: false });
    noteSubagentRunEnd(run.childSessionId, { status: "completed" });

    // harness 可能重复上报 run_end；已经终态的运行不该再投递一次
    noteSubagentRunEnd(run.childSessionId, { status: "completed" });
    noteSubagentRunEnd(run.childSessionId, { status: "failed", error: "迟到的失败" });

    expect(chat.deliverSubagentReport).toHaveBeenCalledTimes(1);
  });

  it("没有报告也照样经过投递入口（由决策层决定不打扰，runner 不做这个判断）", async () => {
    const run = await startRun();

    noteSubagentRunEnd(run.childSessionId, { status: "failed", error: "模型返回错误" });

    // runner 只负责「把终态交出去」，要不要打扰主代理是 report-delivery 的规则
    expect(chat.deliverSubagentReport).toHaveBeenCalledTimes(1);
    const delivered = chat.deliverSubagentReport.mock.calls[0]?.[0] as SubagentRun;
    expect(delivered.report).toBeUndefined();
  });

  it("投递本身抛错不影响收尾：终态与落盘都已经完成", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    chat.deliverSubagentReport.mockImplementationOnce(() => {
      throw new Error("窗口已经关了");
    });
    const run = await startRun();
    noteSubagentAssistantMessage(run.childSessionId, { text: "报告", failed: false });

    expect(() => noteSubagentRunEnd(run.childSessionId, { status: "completed" })).not.toThrow();

    // 终态仍然落盘（投递失败不该让「这个运行结束了」这件事没记下来）
    const last = store.saveSubagentRun.mock.calls.at(-1) as [string, SubagentRun] | undefined;
    expect(last?.[1].status).toBe("completed");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/**
 * 并发名额账本：工具层只做一次同步的 reserveSubagentSlot，真正的占位账本在这里。
 *
 * 回归的是两个曾经叠加的缺陷：预约从不归还（成功启动后一直留在 slotReservations 里）、
 * 计数时又把 liveRuns 与预约各数一遍 —— 于是每条运行被数两遍，跑完的运行永远占着名额，
 * 「派过 4 个（都结束了）之后第 5 个」被永久拒绝，拒绝文案还报出双倍的运行数。
 */
describe("并发名额", () => {
  /**
   * 按工具层的真实顺序派一次：先同步预约、再启动。
   *
   * 必须走这两步 —— 预约才是缺陷的来源（成功启动后没有归还），只调 startSubagentRun
   * 会让 slotReservations 一直是空的，把要验的东西验成空的。
   */
  async function dispatchRun(delegationId: string): Promise<SubagentRun> {
    const reservation = reserveSubagentSlot(PARENT.sessionId, delegationId, "scout");
    expect(reservation.ok).toBe(true);
    return startRun(delegationId);
  }

  /** 起满上限的运行且都不终结（chat.send 是桩，跑不到 run_end） */
  async function startAtLimit(): Promise<SubagentRun[]> {
    const runs: SubagentRun[] = [];
    for (let index = 0; index < MAX_CONCURRENT_SUBAGENT_RUNS; index += 1) {
      runs.push(await dispatchRun(`d-${index}`));
    }
    return runs;
  }

  it("已结束的运行不再占名额：跑完一批之后还能继续派", async () => {
    const runs = await startAtLimit();
    for (const run of runs) {
      noteSubagentRunEnd(run.childSessionId, { status: "completed" });
    }

    // 终态的运行不是「在跑」：名额账本里一个都不该剩下
    expect(subagentSlotHolders(PARENT.sessionId)).toEqual([]);
    expect(reserveSubagentSlot(PARENT.sessionId, "d-next", "scout")).toEqual({ ok: true });
  });

  it("同一次运行只占一个名额：预约与运行记录不会各数一遍", async () => {
    // 先预约、再启动 —— 工具层的真实顺序，中间就是「同一次运行同时躺在两个账本里」的启动窗口
    const reserved = reserveSubagentSlot(PARENT.sessionId, "d-1", "scout");
    expect(reserved.ok).toBe(true);
    const run = await startRun("d-1");

    // 两个账本各数一遍的话这里是 2（拒绝文案因此报出「6 个在跑」而实际只有 3 个）
    expect(subagentSlotHolders(PARENT.sessionId)).toEqual([
      { delegationId: run.delegationId, agentName: "scout" },
    ]);
    // 名额按会话记账：别的会话不受影响
    expect(subagentSlotHolders("s-other")).toEqual([]);
  });

  it("真正到上限时依然拒绝，并带回全部占位者", async () => {
    const runs = await startAtLimit();

    const rejected = reserveSubagentSlot(PARENT.sessionId, "d-next", "scout");
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.holders.map((holder) => holder.delegationId).sort()).toEqual(
      runs.map((run) => run.delegationId).sort(),
    );
  });
});
