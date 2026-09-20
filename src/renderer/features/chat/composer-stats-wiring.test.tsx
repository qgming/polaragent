/**
 * 端到端接线验证（ui project / jsdom）：
 * 主进程事件 → chat-store → 状态条与上下文环的真实渲染。
 *
 * 这是本特性的「接得对不对」总闸：单个组件测试各自用 props 直接喂数据，
 * 这里改走**事件**这条路 —— 事件名或字段拼错、store 分片写错会话、
 * 组件没订阅 store，都会在这里红。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ContextMeter } from "@/renderer/components/assistant-ui/elements/context-meter";
import { StatusBar } from "@/renderer/components/assistant-ui/elements/stats-pills";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessageUsage, SessionStats, SessionTokenUsage } from "@/shared/contracts";

afterEach(() => {
  cleanup();
  useChatStore.setState({
    activeSessionId: null,
    statsBySession: {},
    tokenUsageBySession: {},
    breakdownBySession: {},
  });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const STATS: SessionStats = {
  turns: 1,
  steps: 25,
  llmMs: 351_000,
  toolMs: 12_500,
  ttftMs: 13_700,
  ttftSteps: 1,
  decodeMs: 8_000,
  decodeTokens: 13_184,
};

const USAGE: SessionTokenUsage = {
  uncachedInputTokens: 72_388,
  outputTokens: 14_153,
  cacheReadTokens: 1_054_208,
  cacheWriteTokens: 0,
};

/** 状态条：从 store 读当前会话的两个分片（与 Thread.tsx 里的取法一致） */
function StatusBarFromStore() {
  const stats = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.statsBySession[s.activeSessionId],
  );
  const tokenUsage = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.tokenUsageBySession[s.activeSessionId],
  );
  return <StatusBar stats={stats} tokenUsage={tokenUsage} />;
}

/** 上下文环：已用取最后一条带 usage 的助手消息，窗口按固定值 */
function ContextMeterFromStore() {
  const used = useChatStore((s) => {
    if (s.activeSessionId === null) return 0;
    const messages = s.messagesBySession[s.activeSessionId] ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant" && message.usage !== undefined) {
        const usage: ChatMessageUsage = message.usage;
        return usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
      }
    }
    return 0;
  });
  const breakdown = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.breakdownBySession[s.activeSessionId],
  );
  return <ContextMeter usedTokens={used} contextWindow={1_000_000} breakdown={breakdown} />;
}

/** 一条模拟主进程推来的 usage（四个桶都在） */
function usagePatch(): ChatMessageUsage {
  return {
    inputTokens: 82_500,
    outputTokens: 14_153,
    totalTokens: 96_653,
    uncachedInputTokens: 72_388,
    cacheReadTokens: 1_054_208,
    cacheWriteTokens: 0,
  };
}

describe("事件 → store → 组件 的完整链路", () => {
  it("session-stats 与 token-usage 事件到达后状态条渲染出对应读数", () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<StatusBarFromStore />);
    // 事件之前整条不渲染
    expect(screen.queryByText(/轮/)).toBeNull();

    const store = useChatStore.getState();
    act(() => {
      store.applyEvent("s1", { type: "session-stats", stats: STATS });
      store.applyEvent("s1", { type: "token-usage", usage: USAGE });
    });

    expect(screen.getByText("1 轮 25 步")).toBeTruthy();
    expect(screen.getByText("1648 tok/s")).toBeTruthy();
    expect(screen.getByText("1.1M tok")).toBeTruthy();
    expect(screen.getByText("缓存命中 94%")).toBeTruthy();
  });

  it("context-breakdown 事件到达后上下文环展开面板显示三段", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: {
        s1: [
          {
            id: "a1",
            role: "assistant",
            createdAt: 1,
            parts: [{ type: "text", text: "hi" }],
            status: "complete",
            usage: usagePatch(),
          },
        ],
      },
    });
    render(<ContextMeterFromStore />);

    act(() => {
      useChatStore.getState().applyEvent("s1", {
        type: "context-breakdown",
        breakdown: { systemTokens: 1_800, toolsTokens: 7_100, messageTokens: 63_800 },
      });
    });

    // 已用 = 82500（未缓存输入）+ 1054208? 不——usagePatch 的 inputTokens 与 cacheRead 已分开，
    // 这里压力 = inputTokens + cacheRead + cacheWrite = 82500 + 1054208 + 0
    const button = screen.getByRole("button", { name: /上下文已用/ });
    fireEvent.click(button);

    expect(screen.getByText("系统提示词")).toBeTruthy();
    expect(screen.getByText("~1.8K")).toBeTruthy();
    expect(screen.getByText("工具定义")).toBeTruthy();
    expect(screen.getByText("~7.1K")).toBeTruthy();
    expect(screen.getByText("对话消息")).toBeTruthy();
    expect(screen.getByText("~63.8K")).toBeTruthy();
  });

  it("事件只影响它所属的会话：切走后显示新会话的数据", () => {
    useChatStore.setState({ activeSessionId: "s1" });
    const { rerender } = render(<StatusBarFromStore />);
    act(() => {
      useChatStore.getState().applyEvent("s1", {
        type: "session-stats",
        stats: { ...STATS, turns: 1, steps: 25 },
      });
    });
    expect(screen.getByText("1 轮 25 步")).toBeTruthy();

    // 另一个会话的事件不该改到 s1
    act(() => {
      useChatStore.getState().applyEvent("s2", {
        type: "session-stats",
        stats: { ...STATS, turns: 7, steps: 99 },
      });
    });
    expect(screen.getByText("1 轮 25 步")).toBeTruthy();

    // 切到 s2 后显示 s2 的数字
    act(() => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    rerender(<StatusBarFromStore />);
    expect(screen.getByText("7 轮 99 步")).toBeTruthy();
  });
});
