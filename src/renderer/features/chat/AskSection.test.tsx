/**
 * 提问卡（AskSection）的渲染测试（ui project / jsdom）。
 *
 * 验的是**数据链**而不只是外观：请求从真 store 读、作答写回 store 的 respondAsk，
 * 只换掉 window.oint 这个进程边界 —— 提交后必须真的调用 interaction.respond，
 * 且载荷与界面上的选择/输入逐一对应。这条链断了（卡片没接 store、答题没进载荷）
 * 这里就会红。
 *
 * 卡片是**步进式**（一次一题）：所以这里还要盯住三件事 ——
 * 跨题作答不能丢、回头改不能用旧值、最后一题才允许提交。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { AskRequest } from "@/shared/contracts/interaction";
import { AskSection } from "./AskSection";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** interaction.respond 的替身：断言 IPC 载荷用 */
const respond = vi.fn(async () => undefined);

beforeEach(() => {
  respond.mockClear();
  vi.stubGlobal("oint", {
    interaction: {
      respond,
      pending: vi.fn(async () => []),
    },
  });
  useChatStore.setState({ pendingAsks: [REQUEST] });
});

/** 一次提问两道题：一道多选 + 一道只能自由输入 */
const REQUEST: AskRequest = {
  id: "ask-1",
  sessionId: "s1",
  toolCallId: "call-1",
  createdAt: 1,
  questions: [
    {
      id: "q1",
      header: "配色",
      question: "你希望用哪种配色？",
      options: ["暖色", "冷色", "高对比"],
      multiSelect: true,
    },
    {
      id: "q2",
      header: "说明",
      question: "还有什么要补充的吗？",
    },
  ],
};

/** 与 ChatView 一致的接法：请求从 store 读，作答交给 store 的 respondAsk 走 IPC */
function Harness() {
  const requests = useChatStore((s) => s.pendingAsks);
  return (
    <AskSection
      requests={requests}
      onRespond={(id, reply) => {
        void useChatStore.getState().respondAsk(id, reply);
      }}
    />
  );
}

const nextButton = () => screen.getByRole("button", { name: /下一题/ }) as HTMLButtonElement;
const backButton = () => screen.getByRole("button", { name: /上一题/ }) as HTMLButtonElement;
const submitButton = () => screen.getByRole("button", { name: /提交回答/ }) as HTMLButtonElement;
const optionButton = (name: RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("AskSection（步进式提问卡）", () => {
  it("一次只显示一题：首题时上一题禁用、主按钮是「下一题」，且不会误提交", () => {
    render(<Harness />);

    expect(screen.getByText("模型正在等待你的回答")).toBeTruthy();
    expect(screen.getByText("第 1 / 2 题")).toBeTruthy();
    expect(screen.getByText("你希望用哪种配色？")).toBeTruthy();
    // 第二题此刻不在 DOM 里
    expect(screen.queryByText("还有什么要补充的吗？")).toBeNull();

    expect(backButton().disabled).toBe(true);
    expect(nextButton().getAttribute("type")).toBe("button");

    // 「下一题」只是翻页，不该把请求交出去
    fireEvent.click(nextButton());
    expect(respond).not.toHaveBeenCalled();
    expect(useChatStore.getState().pendingAsks).toHaveLength(1);

    // 翻到最后一题：主按钮才变成提交，且此时没有任何作答 → 禁用
    expect(screen.getByText("第 2 / 2 题")).toBeTruthy();
    expect(screen.queryByText("你希望用哪种配色？")).toBeNull();
    expect(submitButton().disabled).toBe(true);
    // 回车提交走原生表单：提交按钮必须是这张 form 里的 type=submit（改成纯 onClick 这条链就断了）
    expect(submitButton().getAttribute("type")).toBe("submit");
    expect(submitButton().form).not.toBeNull();

    fireEvent.click(submitButton());
    expect(respond).not.toHaveBeenCalled();
  });

  it("选项带字母前缀、跨题保留、回头可改，最后一题提交的载荷与界面一致", async () => {
    render(<Harness />);

    // 选项前有 A/B/C 字母（无障碍名里带着字母，所以用正则匹配）
    expect(optionButton(/暖色/).textContent).toContain("A");
    expect(optionButton(/冷色/).textContent).toContain("B");
    expect(optionButton(/高对比/).textContent).toContain("C");

    // 多选题：两个选项都能同时选中
    fireEvent.click(optionButton(/暖色/));
    fireEvent.click(optionButton(/高对比/));
    expect(optionButton(/暖色/).getAttribute("aria-pressed")).toBe("true");
    expect(optionButton(/高对比/).getAttribute("aria-pressed")).toBe("true");
    expect(optionButton(/冷色/).getAttribute("aria-pressed")).toBe("false");

    // 选项与自由输入可以并存
    fireEvent.change(screen.getByLabelText("你希望用哪种配色？"), {
      target: { value: "不要太亮" },
    });

    // 进入第二题（没有选项，只能自由输入）
    fireEvent.click(nextButton());
    fireEvent.change(screen.getByLabelText("还有什么要补充的吗？"), {
      target: { value: "偏中性一点" },
    });

    // 回头改：上一题的勾选与输入都还在
    fireEvent.click(backButton());
    expect(optionButton(/暖色/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText("你希望用哪种配色？")).toHaveProperty("value", "不要太亮");
    fireEvent.click(optionButton(/冷色/));
    expect(optionButton(/冷色/).getAttribute("aria-pressed")).toBe("true");

    // 回到最后一题提交：载荷按题序给，含回头改动后的结果
    fireEvent.click(nextButton());
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("ask-1", {
        outcome: "answered",
        answers: [
          { questionId: "q1", selected: ["暖色", "高对比", "冷色"], text: "不要太亮" },
          { questionId: "q2", selected: [], text: "偏中性一点" },
        ],
      }),
    );
    // 乐观移除：不等 IPC 回来就把卡片从列表里撤掉
    expect(useChatStore.getState().pendingAsks).toHaveLength(0);
  });

  it("进度圆点可以直接跳到某一题（不必反复点上一题）", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "说明" }));
    expect(screen.getByText("第 2 / 2 题")).toBeTruthy();
    expect(backButton().disabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "配色" }));
    expect(screen.getByText("第 1 / 2 题")).toBeTruthy();
  });
});
