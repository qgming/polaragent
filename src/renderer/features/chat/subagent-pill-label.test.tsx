/**
 * 子智能体 pill 的**文案规则**：终态一律报出状态词。
 *
 * 为什么单独钉这一条：`delegationLabel` 早先收的是 `done: boolean` —— 而那个值来自
 * 元素那三档（working / waiting / done），只有 `completed` 会命中 `done`。于是
 * failed / aborted / denied / truncated / interrupted 五个终态全部落进「进行态」那支，
 * pill 上显示成「名字 · 任务描述」—— 与**还在跑**的样子一模一样。
 *
 * 后果不是「少了个词」而是**读反**：
 *   · 一次失败的委派看起来像还在跑（用户会一直等它）；
 *   · 一次被用户自己停掉的委派，与一次失败、一次意外终止长得毫无区别；
 *   · 而同一个元素的 aria-label 里恰恰**是**带状态词的 —— 看得见的部分与听得到的部分互相打架。
 *
 * 所以判据必须是「结束了没有」（isSubagentRunFinished），不是「成功了没有」。
 * 图标那三档（绿勾只给 completed）仍由 SUBAGENT_AGENT_STATES 单独决定，两者正交：
 * 失败给空心点、文案写「失败」，并不矛盾。
 *
 * 断言口径取用户看得到的东西：pill 上那行文字。
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSubagentStore } from "@/renderer/stores/subagent-store";
import type { SubagentRun, SubagentRunStatus } from "@/shared/contracts/subagent";
import { ToolCallPart } from "./ToolParts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/**
 * 进程边界：pill 会订阅子智能体事件流、并在挂载时向主进程对账一次（refresh）。
 * 这里给一个返回空列表的替身 —— 「本进程里没有活着的运行」是重启后的真实情形，
 * 也正是这批用例要覆盖的路径（行只从转录推导出来）。
 */
function stubBridge(runs: SubagentRun[] = []) {
  vi.stubGlobal("oint", {
    subagents: {
      runs: vi.fn(async () => runs),
      stop: vi.fn(async () => undefined),
      onEvent: vi.fn(),
    },
    sessions: { loadMessages: vi.fn(async () => ({ messages: [] })) },
  });
}

beforeEach(() => {
  stubBridge();
  useChatStore.setState({
    activeSessionId: "s1",
    messagesBySession: {},
    jobsBySession: {},
    jobsReconciledSessions: {},
  });
  // subagent-store 是模块级单例：用例之间会把运行行带过去，必须逐条清空
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

/** 一条运行记录（字段给全，测试按需覆盖） */
function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s1",
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
    tools: [],
    turns: 0,
    toolCalls: 0,
    ...overrides,
  };
}

/**
 * 渲染一条 Task 调用。
 *
 * 子智能体 pill 的数据来自 subagent-store（不是 props）。这里把转录推导那一步
 * 直接做掉：`setRunsFromTranscript` 就是 pill 挂载时会走的那条路（把父会话消息里的
 * Task details 推导成运行行），于是 store 里有了这条运行，pill 渲染的就是它。
 */
function renderTask(r: SubagentRun) {
  // 转录推导：与 pill 挂载时的 effect 同一条路径（不经过 IPC）
  useSubagentStore.getState().setRunsFromTranscript("s1", [
    {
      id: "m1",
      entryId: "m1",
      parentId: null,
      role: "assistant",
      createdAt: 0,
      status: "complete",
      parts: [
        {
          type: "tool-call",
          toolCallId: r.delegationId,
          toolName: "Task",
          args: { description: r.description, task: r.task },
          argsText: "{}",
          details: r,
          status: "done",
        },
      ],
    },
  ]);

  const props = {
    type: "tool-call",
    toolCallId: r.delegationId,
    toolName: "Task",
    args: { description: r.description, task: r.task },
    argsText: JSON.stringify({ description: r.description }),
    artifact: r,
    status: { type: "complete" },
    addResult: () => {},
    resume: () => {},
    respondToApproval: async () => {},
  } as unknown as ToolCallMessagePartProps;

  return render(<ToolCallPart {...props} />);
}

describe("子智能体 pill 的状态词", () => {
  /**
   * 五个非 completed 的终态都要报出状态词。这是本次修复的核心：
   * 它们早先全都显示成「名字 · 任务描述」，与还在跑的样子无从分辨。
   */
  const TERMINAL_CASES: readonly { status: SubagentRunStatus; word: RegExp }[] = [
    { status: "failed", word: /失败/ },
    { status: "aborted", word: /已停止/ },
    { status: "denied", word: /未能启动/ },
    { status: "truncated", word: /达到轮次上限/ },
    { status: "interrupted", word: /意外终止/ },
  ];

  for (const { status, word } of TERMINAL_CASES) {
    it(`${status} 终态在 pill 上说出「${word.source}」而不是只给任务描述`, () => {
      renderTask(run({ status, endedAt: 5_000 }));

      const pill = screen.getByRole("button", { name: /explorer/ });
      expect(pill.textContent).toMatch(word);
    });
  }

  it("completed 照旧报「已完成」", () => {
    renderTask(run({ status: "completed", endedAt: 5_000, report: "结论：重试 3 次" }));

    const pill = screen.getByRole("button", { name: /explorer/ });
    expect(pill.textContent).toMatch(/已完成/);
  });

  it("running 保留任务描述（那时用户关心的是「在干什么」）", () => {
    renderTask(run({ status: "running" }));

    const pill = screen.getByRole("button", { name: /explorer/ });
    expect(pill.textContent).toMatch(/调研重试逻辑/);
  });

  /**
   * 看得见的文字与听得到的名字必须说同一件事。
   *
   * 修复前这两者恰恰相反：aria-label 里带着状态词（`explorer · 失败`），
   * 而可见文案是 `explorer · 调研重试逻辑`（读起来像还在跑）。
   */
  it("可见文案与读屏名不打架：失败的委派两处都说失败", () => {
    renderTask(run({ status: "failed", endedAt: 5_000 }));

    const pill = screen.getByRole("button", { name: /explorer/ });
    expect(pill.textContent).toMatch(/失败/);
    expect(pill.getAttribute("aria-label")).toMatch(/失败/);
  });
});
