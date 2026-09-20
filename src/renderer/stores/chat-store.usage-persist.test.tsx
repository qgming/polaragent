/**
 * 打开会话时读回持久化用量（jsdom project：需要 window.oint）。
 *
 * 覆盖的是「重启后打开旧会话，底栏仍有数据」这条路径：
 * 主进程把用量快照搭在 `sessions.loadMessages` 的返回值里（见 ipc/sessions.ts），
 * 渲染层在首页加载时写进三个分片。这条链断了，用户看到的就是「底部空着」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatMessage,
  ContextBreakdown,
  SessionStats,
  SessionTokenUsage,
} from "@/shared/contracts";
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

const RECORD = {
  stats: stats({ turns: 4, steps: 30 }),
  tokenUsage: usage(),
  breakdown: BREAKDOWN,
};

const loadMessages = vi.fn();

beforeEach(() => {
  useChatStore.setState({
    activeSessionId: null,
    messagesBySession: {},
    loadedSessions: {},
    pageCursorBySession: {},
    hasMoreBySession: {},
    statsBySession: {},
    tokenUsageBySession: {},
    breakdownBySession: {},
  });
  loadMessages.mockReset();
  vi.stubGlobal("oint", { sessions: { loadMessages } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("打开会话时读回持久化用量", () => {
  it("首页加载把 usage 写进三个分片", async () => {
    loadMessages.mockResolvedValue({ messages: [], compactionSummaries: [], usage: RECORD });
    await useChatStore.getState().loadMessages("s1");

    const state = useChatStore.getState();
    expect(state.statsBySession.s1?.steps).toBe(30);
    expect(state.tokenUsageBySession.s1?.cacheReadTokens).toBe(1_054_208);
    expect(state.breakdownBySession.s1).toEqual(BREAKDOWN);
  });

  it("没有快照（新会话 / 旧数据）时不写分片，也不编造全 0", async () => {
    loadMessages.mockResolvedValue({ messages: [], compactionSummaries: [] });
    await useChatStore.getState().loadMessages("s1");

    const state = useChatStore.getState();
    expect(state.statsBySession.s1).toBeUndefined();
    expect(state.tokenUsageBySession.s1).toBeUndefined();
    expect(state.breakdownBySession.s1).toBeUndefined();
  });

  it("向上翻页不用旧快照覆盖运行中的实时数据", async () => {
    // 先有一份实时数据（本轮刚跑出来的）
    useChatStore.setState({
      activeSessionId: "s1",
      statsBySession: { s1: stats({ steps: 99 }) },
      pageCursorBySession: { s1: 100 },
    });
    loadMessages.mockResolvedValue({
      messages: [],
      compactionSummaries: [],
      usage: RECORD,
      nextCursor: 50,
    });

    await useChatStore.getState().loadMessages("s1", { before: true });
    // 翻页返回的是同一份索引快照，不该把实时值盖回 30
    expect(useChatStore.getState().statsBySession.s1?.steps).toBe(99);
  });

  it("消息与用量一起落地：同一次加载把消息写进列表", async () => {
    const message: ChatMessage = {
      id: "m1",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "你好" }],
      status: "complete",
    };
    loadMessages.mockResolvedValue({
      messages: [message],
      compactionSummaries: [],
      usage: RECORD,
    });
    await useChatStore.getState().loadMessages("s1");

    const state = useChatStore.getState();
    expect(state.messagesBySession.s1).toEqual([message]);
    expect(state.statsBySession.s1?.steps).toBe(30);
  });
});
