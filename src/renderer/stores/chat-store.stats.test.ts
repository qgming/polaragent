/**
 * 会话统计事件到 store 的接线测试。
 *
 * 事件来源（运行中推送）落到对应会话的分片里（不是全局一份），
 * 否则切会话时状态条会显示上一个会话的数字。
 * 「打开会话读回持久化快照」那条路需要 window，见 chat-store.usage-persist.test.tsx。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { ContextBreakdown, SessionStats, SessionTokenUsage } from "@/shared/contracts";
import { useChatStore } from "./chat-store";

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    turns: 1,
    steps: 25,
    llmMs: 351_000,
    toolMs: 12_500,
    ttftMs: 13_700,
    ttftSteps: 1,
    decodeMs: 8_000,
    decodeTokens: 13_184,
    ...overrides,
  };
}

function usage(overrides: Partial<SessionTokenUsage> = {}): SessionTokenUsage {
  return {
    uncachedInputTokens: 72_388,
    outputTokens: 14_153,
    cacheReadTokens: 1_054_208,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

const BREAKDOWN: ContextBreakdown = {
  systemTokens: 1_800,
  toolsTokens: 7_100,
  messageTokens: 63_800,
};

describe("会话统计事件接线", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeSessionId: "s1",
      statsBySession: {},
      tokenUsageBySession: {},
      breakdownBySession: {},
    });
  });

  it("session-stats 落到事件所属会话的分片", () => {
    useChatStore.getState().applyEvent("s1", { type: "session-stats", stats: stats() });
    expect(useChatStore.getState().statsBySession.s1?.steps).toBe(25);
    expect(useChatStore.getState().statsBySession.s2).toBeUndefined();
  });

  it("token-usage 落到事件所属会话的分片", () => {
    useChatStore.getState().applyEvent("s2", { type: "token-usage", usage: usage() });
    expect(useChatStore.getState().tokenUsageBySession.s2?.cacheReadTokens).toBe(1_054_208);
    expect(useChatStore.getState().tokenUsageBySession.s1).toBeUndefined();
  });

  it("context-breakdown 落到事件所属会话的分片", () => {
    useChatStore.getState().applyEvent("s1", { type: "context-breakdown", breakdown: BREAKDOWN });
    expect(useChatStore.getState().breakdownBySession.s1).toEqual(BREAKDOWN);
  });

  it("后续事件覆盖同一会话的旧值（不是累加）", () => {
    const store = useChatStore.getState();
    store.applyEvent("s1", { type: "session-stats", stats: stats({ steps: 1 }) });
    store.applyEvent("s1", { type: "session-stats", stats: stats({ steps: 2 }) });
    expect(useChatStore.getState().statsBySession.s1?.steps).toBe(2);
  });

  it("两个会话各存一份，互不串味", () => {
    const store = useChatStore.getState();
    store.applyEvent("s1", { type: "session-stats", stats: stats({ turns: 1 }) });
    store.applyEvent("s2", { type: "session-stats", stats: stats({ turns: 9 }) });
    const state = useChatStore.getState();
    expect(state.statsBySession.s1?.turns).toBe(1);
    expect(state.statsBySession.s2?.turns).toBe(9);
  });
});
