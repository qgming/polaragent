/**
 * 任务清单区块（TodoPanel）的渲染测试（ui project / jsdom）。
 *
 * 区块从「贴在输入框上沿的独立面板」迁进了会话面板，语义变了两处，测试跟着改：
 *   · 区块**始终渲染**：没有 todo 调用时给空态文案（展开后可见），不再整块消失；
 *     有清单时 autoOpen 自动展开，用户手动收过之后不再自动弹开
 *   · 进度从 TodoList 的标题行文字改成折叠头右侧的徽标「已完成/总数」；
 *     全部完成时徽标转绿、区块不消失（用户正看着它）
 *
 * 验的仍是**数据链**而不只是外观：消息按 ChatMessage（也就是主进程历史回读那一层的形状）
 * 构造，经 toTodoPanelMessages 把 details 搬进 part.artifact 后由区块从活动会话重建清单。
 * 这条链断了（区块读不到 store 里活动会话的消息、或读错了槽位）这里就会红。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessage } from "@/shared/contracts/session";
import { TodoPanel } from "./TodoPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

// 每条用例从空 store 开始：区块只读 activeSessionId 下的那份消息
// （事件桥的 part-upsert 写进去的是同一个数组，不用经 aui 线程状态转发）
beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1", messagesBySession: { s1: [] } });
});

/** 把消息塞进当前会话（模拟事件累积完成 / 历史回读完成） */
function seed(messages: ChatMessage[], sessionId = "s1") {
  useChatStore.setState({
    activeSessionId: sessionId,
    messagesBySession: { [sessionId]: messages },
  });
}

/** 一条只带 todo 工具调用的助手消息（details 就是主进程产出的那份清单） */
function todoMessage(id: string, details: unknown): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: 0,
    status: "complete",
    parts: [
      {
        type: "tool-call",
        toolCallId: `call-${id}`,
        toolName: "todo",
        argsText: "{}",
        details,
        status: "done",
      },
    ],
  };
}

const FIRST_DETAIL = {
  todos: [
    { id: "1", text: "读一遍现有实现", status: "done" },
    { id: "2", text: "写面板", status: "active" },
  ],
  revision: 3,
};

const SECOND_DETAIL = {
  todos: [{ id: "9", text: "跑测试", status: "pending" }],
  revision: 4,
};

/** 收尾后的清单：内核提示词要求任务做完时发一份每项都 done 的表 */
const DONE_DETAIL = {
  todos: [
    { id: "1", text: "读一遍现有实现", status: "done" },
    { id: "2", text: "写面板", status: "done" },
  ],
  revision: 5,
};

const NO_TODO: ChatMessage[] = [
  {
    id: "m-text",
    role: "assistant",
    createdAt: 0,
    status: "complete",
    parts: [{ type: "text", text: "先看一眼" }],
  },
];
const ONE_TODO: ChatMessage[] = [todoMessage("m1", FIRST_DETAIL)];
const TWO_TODO: ChatMessage[] = [todoMessage("m1", FIRST_DETAIL), todoMessage("m2", SECOND_DETAIL)];
const ALL_DONE: ChatMessage[] = [todoMessage("m1", FIRST_DETAIL), todoMessage("m2", DONE_DETAIL)];

const panel = () => document.querySelector('[data-slot="todo-panel"]');
/** 折叠头的无障碍名称（toggleLabel） */
const trigger = () => screen.getByRole("button", { name: "展开或收起任务清单" });
/** 折叠头右侧的计数徽标：undefined = 还没有清单，不摆一个「0」 */
const badgeEl = () => document.querySelector('[data-slot="todo-count"]');
const badge = () => badgeEl()?.textContent ?? null;

describe("TodoPanel", () => {
  it("没有 todo 调用时区块仍然渲染：展开后给空态文案，且不渲染徽标", () => {
    seed(NO_TODO);
    render(<TodoPanel />);

    // 折叠头始终在（区块不再整块消失），只是内容默认收起
    expect(panel()).not.toBeNull();
    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(badge()).toBeNull();

    fireEvent.click(trigger());
    expect(screen.getByText("本次会话还没有任务清单")).toBeTruthy();
    expect(badge()).toBeNull();
  });

  it("从消息流的 details 重建清单：条目与计数都来自结果", () => {
    seed(ONE_TODO);
    render(<TodoPanel />);

    // 有清单时 autoOpen：浮层一打开就是展开的，条目与计数立刻在
    expect(screen.getByText("读一遍现有实现")).toBeTruthy();
    expect(screen.getByText("写面板")).toBeTruthy();
    // 计数改成右侧徽标「已完成/总数」；revision 不再上屏（TodoList 关掉了自带标题行）
    expect(badge()).toBe("1/2");
  });

  it("有多条 todo 调用时显示最后一份", () => {
    seed(TWO_TODO);
    render(<TodoPanel />);

    expect(screen.getByText("跑测试")).toBeTruthy();
    expect(badge()).toBe("0/1");
    expect(screen.queryByText("写面板")).toBeNull();
  });

  it("清单全部完成后区块不消失：徽标是 n/n 并转绿", () => {
    seed(ALL_DONE);
    render(<TodoPanel />);

    // 与旧语义相反：收尾不再让整块消失 —— 用户此刻正看着它
    expect(panel()).not.toBeNull();
    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(badge()).toBe("2/2");
    // 完成态用绿色系（与工具卡绿勾同一支颜色）
    expect(badgeEl()?.className).toContain("text-emerald-600");
    expect(screen.getByText("写面板")).toBeTruthy();
  });

  it("还剩未完成项时照常显示，徽标保持中性色", () => {
    seed(TWO_TODO);
    render(<TodoPanel />);

    expect(screen.getByText("跑测试")).toBeTruthy();
    // 条目状态（TodoList 的无障碍文本）跟着结果走：这条还没做
    expect(screen.getByText("pending")).toBeTruthy();
    expect(badge()).toBe("0/1");
    expect(badgeEl()?.className).not.toContain("text-emerald-600");
  });

  it("有清单时自动展开；手动收起之后内容不再把它顶开", () => {
    seed(ONE_TODO);
    render(<TodoPanel />);

    // autoOpen：有清单就自动展开
    const button = trigger();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("读一遍现有实现")).toBeTruthy();

    // 手动收起是明确意愿，收起后内容不在 DOM 里
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("读一遍现有实现")).toBeNull();

    // 后续内容变化（清空 → 又出现清单）不该推翻这次收起
    act(() => {
      seed(NO_TODO);
    });
    act(() => {
      seed(TWO_TODO);
    });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("跑测试")).toBeNull();
  });
});
