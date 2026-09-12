/**
 * TodoPanel 的渲染测试（ui project / jsdom）。
 *
 * 它验的是**数据链**而不只是外观：消息按 ChatMessage（也就是主进程历史回读那一层的形状）构造，
 * 经 runtime 的 message-converter 把 details 搬进 part.artifact，再由面板在 Thread 的
 * primitive 之外读到线程消息。这条链断了（面板读不到消息、或读错了槽位）这里就会红。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import type { ChatMessage } from "@/shared/contracts/session";
import { TodoPanel } from "./TodoPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

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

// 数组常量放在模块层：runtime 会按引用比较 messages，每次渲染给新数组会把它推进循环
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

/** 挂在与应用一致的位置：runtime provider 之下（应用里实际由 Composer 渲染，这里单独挂以便断言） */
function Harness({ messages }: { messages: ChatMessage[] }) {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning: false,
    convertMessage: toThreadMessage,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TodoPanel />
    </AssistantRuntimeProvider>
  );
}

describe("TodoPanel", () => {
  it("没有 todo 调用时整块不渲染（不占垂直空间）", () => {
    const { container } = render(<Harness messages={NO_TODO} />);
    expect(container.querySelector('[data-slot="todo-panel"]')).toBeNull();
    expect(screen.queryByText("待办清单")).toBeNull();
  });

  it("从消息流的 details 重建清单：条目、计数与 revision 都来自结果", async () => {
    render(<Harness messages={ONE_TODO} />);
    expect(await screen.findByText("待办清单")).toBeTruthy();
    expect(screen.getByText("读一遍现有实现")).toBeTruthy();
    expect(screen.getByText("写面板")).toBeTruthy();
    expect(screen.getByText("1/2 · rev 3")).toBeTruthy();
  });

  it("有多条 todo 调用时显示最后一份", async () => {
    render(<Harness messages={TWO_TODO} />);
    expect(await screen.findByText("跑测试")).toBeTruthy();
    expect(screen.getByText("0/1 · rev 4")).toBeTruthy();
    expect(screen.queryByText("写面板")).toBeNull();
  });

  it("默认展开，点标题行可收起", async () => {
    render(<Harness messages={ONE_TODO} />);
    const trigger = await screen.findByRole("button", { name: "展开或收起待办清单" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });
});
