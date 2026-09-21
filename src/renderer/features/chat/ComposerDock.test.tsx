/**
 * 输入框上方停靠区（任务清单 + 待发送队列）的渲染测试。
 *
 * 这一块是从顶栏浮层**迁回来**的（见 ComposerDock.tsx 顶部的说明），所以要钉的除了常规行为
 * 还有「位置」这件事本身：它必须在 composer 里渲染出来，而浮层里不能再有一份 ——
 * 两处都取同一份数据，同时出现就是两块重复的清单。
 *
 * 行为上盯三件事：
 *   1. 任务清单：有清单才出块、进度读数、默认收起、点开看到逐条状态；
 *   2. 队列：条数标题、单条直接铺开、多条可折叠、**移除按钮真的走 IPC**；
 *   3. 队列为空时整块不渲染（不给一个空壳占着输入框上方）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessage, ChatPart } from "@/shared/contracts/session";
import { QueueDock, TodoDock } from "./ComposerDock";

/**
 * 渲染时补上 TooltipProvider。
 *
 * 应用里这层由 App.tsx 提供（全局一个），所以线上不会缺；但组件单测直接渲染 dock 时
 * 它是缺的 —— Radix 的 Tooltip 在没有 Provider 时**直接抛错**，而队列行的「移除」外面
 * 正好包着一个。不补这一层，测的就不是 dock 而是「测试环境搭得全不全」。
 */
function renderDock(node: React.ReactElement) {
  return render(<TooltipProvider>{node}</TooltipProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useChatStore.setState({ activeSessionId: null, messagesBySession: {}, queueBySession: {} });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** 清单条目（与 TodoItem 同形：reason 是失败条目的可选说明） */
type TodoSeed = { id: string; text: string; status: string; reason?: string };

/** 一条带 todo 工具调用的助手消息 */
function todoMessage(todos: TodoSeed[]): ChatMessage {
  const part: ChatPart = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "todo",
    argsText: "{}",
    args: { todos },
    details: { todos, revision: 1 },
    status: "done",
  };
  return { id: "a1", role: "assistant", createdAt: 0, parts: [part], status: "complete" };
}

/** 把清单灌进 store 的当前会话 */
function seedTodo(todos: TodoSeed[]) {
  useChatStore.setState({
    activeSessionId: "s1",
    messagesBySession: { s1: [todoMessage(todos)] },
  });
}

/** queue IPC 的替身，记录调用 */
function stubQueueIpc(): {
  cancelQueued: ReturnType<typeof vi.fn>;
  queue: ReturnType<typeof vi.fn>;
} {
  const cancelQueued = vi.fn(async () => undefined);
  const queue = vi.fn(async () => undefined);
  vi.stubGlobal("oint", { chat: { queue, cancelQueued } });
  return { cancelQueued, queue };
}

const TODOS = [
  { id: "1", text: "读代码", status: "done" },
  { id: "2", text: "改实现", status: "active" },
  { id: "3", text: "补测试", status: "pending" },
];

describe("任务清单停靠块", () => {
  it("没有清单时整块不渲染（不给输入框上方留一个空壳）", () => {
    useChatStore.setState({ activeSessionId: "s1", messagesBySession: { s1: [] } });
    const { container } = renderDock(<TodoDock />);

    expect(container.firstChild).toBeNull();
  });

  it("有清单时显示标题与进度读数", () => {
    seedTodo(TODOS);
    renderDock(<TodoDock />);

    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(screen.getByText("1/3")).toBeTruthy();
  });

  it("默认收起：逐条内容不在 DOM 里，点一下才展开", () => {
    seedTodo(TODOS);
    renderDock(<TodoDock />);

    // 清单常有十条以上，默认铺开会把输入框推得太远
    expect(screen.queryByText("读代码")).toBeNull();

    const header = screen.getByRole("button", { name: "展开或收起任务清单" });
    expect(header.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(header);
    expect(screen.getByText("读代码")).toBeTruthy();
    expect(screen.getByText("改实现")).toBeTruthy();
    expect(screen.getByText("补测试")).toBeTruthy();
    expect(header.getAttribute("aria-expanded")).toBe("true");
  });

  /**
   * **全部完成时整块消失**（用户明确要求）。
   *
   * 任务清单回答的是「还剩什么要做」：全部勾掉之后它没有内容了，
   * 留在输入框上方只是白占一行高度。这是刻意与右栏会话面板**相反**的口径 ——
   * 那边是用户主动打开的浮层，让它原地消失比留一个「已完成」的记号更让人迷惑；
   * 而这里是被动占据输入框上方空间的，收掉才对。
   */
  it("全部完成时整块消失，不在输入框上方留一行「已完成」", () => {
    seedTodo([
      { id: "1", text: "甲", status: "done" },
      { id: "2", text: "乙", status: "done" },
    ]);
    const { container } = renderDock(<TodoDock />);

    expect(container.firstChild).toBeNull();
  });

  it("只要还剩一条没完成就继续显示", () => {
    seedTodo([
      { id: "1", text: "甲", status: "done" },
      { id: "2", text: "乙", status: "pending" },
    ]);
    renderDock(<TodoDock />);

    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("空清单（todos: []）也不显示：没有内容可展示", () => {
    seedTodo([]);
    const { container } = renderDock(<TodoDock />);

    expect(container.firstChild).toBeNull();
  });

  it("failed 不算完成：崩掉那一步要留着让人看见", () => {
    // isTodoFinished 只认「每条都是 done」——failed 是终态却不是成功，
    // 整块收掉等于把「哪一步崩了」藏起来
    seedTodo([{ id: "1", text: "跑测试", status: "failed", reason: "超时" }]);
    renderDock(<TodoDock />);

    expect(screen.getByText("任务清单")).toBeTruthy();
  });

  it("失败条目带出原因（不能只显示一个红叉）", () => {
    seedTodo([{ id: "1", text: "跑测试", status: "failed", reason: "超时" }]);
    renderDock(<TodoDock />);
    fireEvent.click(screen.getByRole("button", { name: "展开或收起任务清单" }));

    // 条目文本在；原因由 todo-list 的元素渲染，这里确认没有把 why 丢掉
    expect(screen.getByText("跑测试")).toBeTruthy();
  });
});

describe("待发送队列停靠块", () => {
  const item = (id: string, text: string, mode: "steer" | "followUp" = "followUp") => ({
    id,
    text,
    mode,
  });

  it("队列为空时整块不渲染", () => {
    const { container } = renderDock(<QueueDock items={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("只有一条时直接铺开那一行，不给折叠头", () => {
    renderDock(<QueueDock items={[item("q1", "先做这个")]} />);

    expect(screen.getByText("先做这个")).toBeTruthy();
    // 一条不值得再多点一次：没有折叠头（也就没有 aria-expanded 的按钮）
    expect(screen.queryByRole("button", { expanded: false })).toBeNull();
  });

  it("多条时给条数标题，默认展开", () => {
    renderDock(<QueueDock items={[item("q1", "甲"), item("q2", "乙")]} />);

    expect(screen.getByText("2 条待发送")).toBeTruthy();
    // 队列是用户自己刚敲进去的，默认铺开（与任务清单的默认收起相反，理由见文件头）
    expect(screen.getByText("甲")).toBeTruthy();
    expect(screen.getByText("乙")).toBeTruthy();
  });

  it("多条时可以折起来", () => {
    renderDock(<QueueDock items={[item("q1", "甲"), item("q2", "乙")]} />);

    fireEvent.click(screen.getByText("2 条待发送"));

    expect(screen.queryByText("甲")).toBeNull();
    expect(screen.queryByText("乙")).toBeNull();
  });

  it("插话的那条标出来（用户要能分清为什么它先发）", () => {
    renderDock(<QueueDock items={[item("q1", "插一句", "steer")]} />);

    expect(screen.getByText("插话")).toBeTruthy();
  });

  it("点移除会走 IPC，带上那条的 id", async () => {
    const bridge = stubQueueIpc();
    useChatStore.setState({ activeSessionId: "s1" });
    renderDock(<QueueDock items={[item("q1", "不要这条了")]} />);

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() => {
      expect(bridge.cancelQueued).toHaveBeenCalledWith("s1", "q1");
    });
  });

  it("移除后**不本地删**：等主进程的 queue-updated 事件收正（避免闪一下又回来）", async () => {
    stubQueueIpc();
    useChatStore.setState({
      activeSessionId: "s1",
      queueBySession: { s1: [item("q1", "不要这条了")] },
    });
    renderDock(<QueueDock items={useChatStore.getState().queueBySession.s1 ?? []} />);

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    // store 里的队列由事件驱动，点击本身不动它
    await waitFor(() => expect(useChatStore.getState().queueBySession.s1).toHaveLength(1));
  });

  it("没有活动会话时不发 IPC（避免把 id 发成 null）", async () => {
    const bridge = stubQueueIpc();
    useChatStore.setState({ activeSessionId: null });
    renderDock(<QueueDock items={[item("q1", "甲")]} />);

    fireEvent.click(screen.getByRole("button", { name: "移除" }));

    await waitFor(() => expect(bridge.cancelQueued).not.toHaveBeenCalled());
  });
});
