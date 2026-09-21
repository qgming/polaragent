/**
 * subagent-store 的合并与对账规则（node project，store 本身不依赖 DOM）。
 *
 * 验的是用户报的那个症状背后的纯逻辑：重启后转录里的旧记录还写着 running，
 * 而主进程的权威列表（`subagents:runs`）里已经没有它了 —— 渲染层必须在那一刻把它
 * 显示成 interrupted，而不是继续给一个永远转圈、永远 0 轮的幽灵行。
 *
 * window.oint 是 store 唯一的外部依赖（IPC），逐条用例换成替身；不 mock 模块。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolCallPart } from "@/shared/contracts/session";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { parseSubagentRun, preferDurable, useSubagentStore } from "./subagent-store";

const SESSION = "s-parent";

/** 一条完整的运行记录；各用例只改自己关心的那几项 */
function runFixture(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: SESSION,
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "explorer",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "读 src/retry.ts",
    status: "running",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    tools: ["read", "grep", "glob"],
    turns: 0,
    toolCalls: 0,
    ...patch,
  };
}

/** 转录里的一条 Task 调用：details 挂着运行记录（重启后唯一的持久来源） */
function taskMessage(run: SubagentRun): ChatMessage {
  const part: ToolCallPart = {
    type: "tool-call",
    toolCallId: run.delegationId,
    toolName: "Task",
    argsText: "{}",
    details: run,
    status: "done",
  };
  return {
    id: `m-${run.delegationId}`,
    role: "assistant",
    createdAt: 1,
    parts: [part],
    status: "complete",
  };
}

/**
 * 只补 store 会调到的两条通道：runs()（权威列表）与 sessions.loadMessages（子会话转录）。
 * runs 传 Error 表示这次 IPC 失败。返回的 mock 可以改后续返回值。
 */
function stubBridge(runs: SubagentRun[] | Error) {
  const runsMock = vi.fn(async () => {
    if (runs instanceof Error) throw runs;
    return runs;
  });
  vi.stubGlobal("window", {
    oint: {
      subagents: { runs: runsMock, stop: vi.fn(async () => undefined), onEvent: vi.fn() },
      sessions: { loadMessages: vi.fn(async () => ({ messages: [] })) },
    },
  });
  return runsMock;
}

/** 每条用例都从空 store 开始：create 出来的是模块级单例，用例之间会串状态 */
beforeEach(() => {
  useSubagentStore.setState({
    runs: {},
    durableRuns: {},
    liveRuns: {},
    childMessages: {},
    requestedChildren: {},
    watchedSessions: {},
    reconciledSessions: {},
    authoritativeIds: {},
  });
});

/** 转录先到（重启后的第一帧）：这一行就是磁盘上那条陈旧的 running 记录 */
function seedTranscriptRun(run: SubagentRun): void {
  useSubagentStore.getState().setRunsFromTranscript(SESSION, [taskMessage(run)]);
}

describe("subagent-store · 未被权威列表确认的 running 行", () => {
  it("对账前保持 running：启动瞬间不能先闪一屏「意外终止」", () => {
    stubBridge([]);
    seedTranscriptRun(runFixture());

    expect(useSubagentStore.getState().runs[SESSION]?.[0]?.status).toBe("running");
    expect(useSubagentStore.getState().reconciledSessions[SESSION]).toBeUndefined();
  });

  it("对账后：权威列表里没有的 running 行降级成 interrupted，并把 endedAt 冻结在最后更新时刻", async () => {
    stubBridge([]); // 主进程：本进程里没有任何活着的运行
    seedTranscriptRun(runFixture({ updatedAt: 4_000 }));
    await useSubagentStore.getState().refresh(SESSION);

    const row = useSubagentStore.getState().runs[SESSION]?.[0];
    expect(row?.status).toBe("interrupted");
    // endedAt 对齐到 updatedAt（最后被持久化 = 最后活着的时间），耗时因此不再增长
    expect(row?.endedAt).toBe(4_000);
    expect(useSubagentStore.getState().reconciledSessions[SESSION]).toBe(true);
  });

  it("权威列表里点名的 running 行仍然是 running", async () => {
    stubBridge([runFixture({ turns: 3 })]);
    seedTranscriptRun(runFixture());
    await useSubagentStore.getState().refresh(SESSION);

    expect(useSubagentStore.getState().runs[SESSION]?.[0]?.status).toBe("running");
  });

  it("refresh 失败不算对账：行保持 running，下次还能再确认", async () => {
    stubBridge(new Error("IPC 挂了"));
    seedTranscriptRun(runFixture());
    await useSubagentStore.getState().refresh(SESSION);

    expect(useSubagentStore.getState().runs[SESSION]?.[0]?.status).toBe("running");
    expect(useSubagentStore.getState().reconciledSessions[SESSION]).toBeUndefined();
  });

  it("对账之后转录又送来一条 running 行，同样按未确认降级（规则在落定层出口，不只 refresh）", async () => {
    stubBridge([]);
    await useSubagentStore.getState().refresh(SESSION);
    // 对账时还没有这条委派：之后转录才把它带回来，它同样不在权威名单里
    seedTranscriptRun(
      runFixture({
        delegationId: "d-2",
        parentToolCallId: "d-2",
        childSessionId: "child-2",
        updatedAt: 2_000,
      }),
    );

    const row = useSubagentStore
      .getState()
      .runs[SESSION]?.find((run) => run.delegationId === "d-2");
    expect(row?.status).toBe("interrupted");
    expect(row?.endedAt).toBe(2_000);
  });

  it("实时事件行仍然赢：本进程确认在跑的行不会被降级盖掉", async () => {
    stubBridge([]);
    seedTranscriptRun(runFixture());
    await useSubagentStore.getState().refresh(SESSION);
    expect(useSubagentStore.getState().runs[SESSION]?.[0]?.status).toBe("interrupted");

    // 同一个 delegationId 的事件又回来了（它其实还在这个进程里跑）：第一手证据优先
    useSubagentStore.getState().applyEvent(SESSION, {
      type: "run-started",
      run: runFixture({ turns: 2, toolCalls: 1 }),
    });

    const row = useSubagentStore.getState().runs[SESSION]?.[0];
    expect(row?.status).toBe("running");
    expect(row?.turns).toBe(2);
  });

  it("事件行不受降级影响的前提是有人在看：没订阅过的会话不接事件", () => {
    stubBridge([]);
    useSubagentStore.getState().applyEvent(SESSION, {
      type: "run-started",
      run: runFixture(),
    });
    // watchedSessions 的闸门照旧：没人在看的会话不为它保留事件（详见 store 里的说明）
    expect(useSubagentStore.getState().runs[SESSION]).toBeUndefined();
  });
});

describe("subagent-store · preferDurable 的可信度排序", () => {
  it("陈旧的 running 行不覆盖终态（含 interrupted）", () => {
    const stale = runFixture(); // running / turns 0
    const interrupted = runFixture({ status: "interrupted", endedAt: 4_000, updatedAt: 4_000 });
    const completed = runFixture({ status: "completed", endedAt: 9_000 });
    const denied = runFixture({ status: "denied" }); // 起不来的终态本来就没有 endedAt

    expect(preferDurable(interrupted, stale)).toBe(interrupted);
    expect(preferDurable(completed, stale)).toBe(completed);
    // 只看 endedAt 的老规则会在这条上翻车：denied 没有 endedAt，会被 running 盖回去
    expect(preferDurable(denied, stale)).toBe(denied);
  });

  it("同为运行中时取轮次多的那行：转录的 details 可能停在派发那一刻", () => {
    const authoritative = runFixture({ turns: 5, toolCalls: 4 });
    const fromTranscript = runFixture();
    expect(preferDurable(authoritative, fromTranscript)).toBe(authoritative);
    expect(preferDurable(fromTranscript, authoritative)).toBe(authoritative);
  });

  it("同级取新到的那行", () => {
    const older = runFixture({ turns: 3 });
    const newer = runFixture({ turns: 3, toolCalls: 7 });
    expect(preferDurable(older, newer)).toBe(newer);
  });
});

describe("subagent-store · parseSubagentRun 的新状态与字段", () => {
  it("接受 interrupted（否则对账后的行会在推导层被整条丢掉）", () => {
    const run = parseSubagentRun(runFixture({ status: "interrupted", updatedAt: 4_000 }));
    expect(run?.status).toBe("interrupted");
    expect(run?.updatedAt).toBe(4_000);
  });

  it("resumedFrom 只在非空字符串时带上", () => {
    expect(parseSubagentRun(runFixture({ resumedFrom: "d-0" }))?.resumedFrom).toBe("d-0");
    expect(parseSubagentRun(runFixture({ resumedFrom: "" }))?.resumedFrom).toBeUndefined();
  });
});

describe("subagent-store · 报告随工具结果回到主会话", () => {
  /**
   * 这条链是本次修复的核心形状：报告写在**那次 Task 调用的 details** 上
   * （主进程在运行收尾时回填），渲染层从转录推导出带 report 的行，pill 才能显示
   * 「xxx 已完成」并把报告铺在下面。
   *
   * 为什么值得单独钉：以前报告是「推一条消息」，形状换了之后，
   * 万一 details 里的 report 在推导层被丢掉（比如某个字段没被 parseSubagentRun 保留），
   * 表现就是「pill 说已完成、下面的报告却是空的」—— 正是用户报的那个症状。
   */
  it("转录里 details.report 会被推导出来：pill 靠它显示结果", () => {
    stubBridge([]);
    seedTranscriptRun(
      runFixture({ status: "completed", report: "重试上限是 3 次，见 src/retry.ts:42。" }),
    );

    const row = useSubagentStore.getState().runs[SESSION]?.[0];
    expect(row?.status).toBe("completed");
    expect(row?.report).toBe("重试上限是 3 次，见 src/retry.ts:42。");
  });

  it("报告从无到有会被当成变化：否则界面会停在「已完成但没有报告」", () => {
    stubBridge([]);
    seedTranscriptRun(runFixture({ status: "running" }));
    seedTranscriptRun(runFixture({ status: "completed", report: "迟到的报告" }));

    expect(useSubagentStore.getState().runs[SESSION]?.[0]?.report).toBe("迟到的报告");
  });
});

/**
 * 本次修复的用户症状回归：**重启后已完成却显示「运行中 · 0s」**。
 *
 * 成因值得写在这里，因为它决定了修复为什么必须落在这条链上：
 * 主会话转录里 `Task` 的 details 落的是**派发那一刻**的快照（status: running、turns: 0、
 * 没有 endedAt），此后永不更新 —— 真实结局只写在子会话索引里。
 * 而主会话里的 pill 以前只做 setRunsFromTranscript、从不 refresh，于是永远显示那份陈旧快照：
 * 状态是「运行中」，耗时按 now - startedAt 算又因为 turns/endedAt 缺失而看不出进展。
 *
 * 现在 ToolParts 的 effect 会紧接着调 refresh（见那边的注释）。这条用例钉住
 * 「陈旧 running 被权威 completed 覆盖」这个结果本身 —— 只要这条成立，
 * 界面就会显示「已完成」并带上真实耗时，无论转录里那份快照多旧。
 */
describe("subagent-store · 重启后陈旧的 running 行被权威列表纠正", () => {
  it("转录说 running / turns=0，权威说 completed + endedAt → 界面拿到 completed 与真实耗时", async () => {
    const stale = runFixture({ status: "running", turns: 0, toolCalls: 0 });
    const truth = runFixture({ status: "completed", turns: 5, toolCalls: 11, endedAt: 9_000 });
    stubBridge([truth]);
    // 重启后的第一帧：只有转录那份派发快照
    seedTranscriptRun(stale);
    await useSubagentStore.getState().refresh(SESSION);

    const row = useSubagentStore.getState().runs[SESSION]?.[0];
    expect(row?.status).toBe("completed");
    expect(row?.turns).toBe(5);
    // 耗时靠 endedAt 才成立：这正是「一直 0s」的解药
    expect(row?.endedAt).toBe(9_000);
  });
});
