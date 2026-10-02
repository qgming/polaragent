import type { JsonValue } from "@earendil-works/chord";
import { diffRevisions } from "@earendil-works/chord/delta";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatLiveSnapshot } from "@/shared/contracts/chat";
import type { ChatMessage, SessionMessagesPage } from "@/shared/contracts/session";
import { useChatStore } from "./chat-store";
import { viewEvent } from "./chat-view-test";

const message = (id: string, text: string, entryId?: string): ChatMessage => ({
  id,
  entryId,
  role: "assistant",
  createdAt: 1,
  parts: [{ type: "text", text }],
  status: entryId ? "complete" : "streaming",
});
beforeEach(() =>
  useChatStore.setState({
    messagesBySession: {},
    viewsBySession: {},
    loadedSessions: {},
    historyEpochBySession: {},
    loadingFirstBySession: {},
    loadingOlderBySession: {},
    pageCursorBySession: {},
    hasMoreBySession: {},
    runningBySession: {},
    queueBySession: {},
    activeSessionId: "s1",
  }),
);
function base(generation = 1) {
  const event = viewEvent({ running: true, messages: [message("live:1:2", "first")] }, generation);
  if (event.type !== "view" || !("state" in event.frame)) throw new Error("Missing base");
  return event.frame;
}
function apply(snapshot: ChatLiveSnapshot) {
  useChatStore.getState().applyEvent("s1", { type: "view", frame: snapshot });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("canonical native view frames", () => {
  it("applies official Chord text operations without a second part buffer", () => {
    const initial = base();
    apply(initial);
    const state = { ...initial.state, messages: [message("live:1:2", "first more text")] };
    const ops = diffRevisions(initial.state as unknown as JsonValue, state as unknown as JsonValue);
    useChatStore.getState().applyEvent("s1", {
      type: "view",
      frame: {
        generation: initial.generation,
        previousRevision: initial.revision,
        revision: initial.revision + 1,
        ops,
      },
    });
    expect(useChatStore.getState().messagesBySession.s1?.[0]?.parts[0]).toEqual({
      type: "text",
      text: "first more text",
    });
    expect(ops.some((op) => op[0] === "a")).toBe(true);
  });
  it("replaces an in-flight message with its committed entry exactly once", () => {
    const initial = base();
    apply(initial);
    apply({
      ...initial,
      revision: initial.revision + 1,
      state: {
        ...initial.state,
        running: false,
        messages: [message("entry:3", "final", "entry:3")],
      },
    });
    expect(useChatStore.getState().messagesBySession.s1?.map((item) => item.id)).toEqual([
      "entry:3",
    ]);
  });
  it("drops late frames from the previous branch and stale reconnect snapshots", () => {
    const old = base(100);
    apply(old);
    const fresh = base(101);
    apply(fresh);
    apply({ ...old, revision: 9999, state: { ...old.state, messages: [message("wrong", "old")] } });
    apply({ ...fresh, revision: fresh.revision - 1, state: { ...fresh.state, messages: [] } });
    expect(useChatStore.getState().viewsBySession.s1).toEqual(fresh);
  });
  it("requests a current base when an operation frame has a revision gap", async () => {
    const initial = base();
    apply(initial);
    const recovered = {
      ...initial,
      revision: initial.revision + 10,
      state: { ...initial.state, messages: [message("live:1:2", "recovered")] },
    };
    const snapshot = vi.fn(async () => recovered);
    vi.stubGlobal("window", { oint: { chat: { snapshot } } });
    useChatStore.getState().applyEvent("s1", {
      type: "view",
      frame: {
        generation: initial.generation,
        previousRevision: initial.revision + 8,
        revision: initial.revision + 9,
        ops: [],
      },
    });
    await vi.waitFor(() => expect(useChatStore.getState().viewsBySession.s1).toEqual(recovered));
    expect(snapshot).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
  it("keeps paged history through compaction and applies a later report to its original card", () => {
    const tool: ChatMessage = {
      id: "entry:1",
      entryId: "entry:1",
      role: "assistant",
      createdAt: 1,
      status: "complete",
      parts: [
        { type: "tool-call", toolCallId: "task", toolName: "Task", argsText: "{}", status: "done" },
      ],
    };
    useChatStore.setState({ messagesBySession: { s1: [tool] } });
    const initial = base();
    apply(initial);
    apply({
      ...initial,
      revision: initial.revision + 1,
      state: {
        ...initial.state,
        messages: [],
        running: false,
        reports: { task: { text: "finished", isError: false, details: { status: "completed" } } },
      },
    });
    expect(useChatStore.getState().messagesBySession.s1).toHaveLength(1);
    expect(useChatStore.getState().messagesBySession.s1?.[0]?.parts[0]).toMatchObject({
      result: "finished",
      details: { status: "completed" },
    });
  });
  it("replaces the optimistic input on the first native commit without duplicates", () => {
    const optimistic: ChatMessage = {
      id: "request-1",
      role: "user",
      createdAt: 1,
      parts: [{ type: "text", text: "hello" }],
      status: "complete",
    };
    useChatStore.setState({ messagesBySession: { s1: [optimistic] } });
    const initial = base();
    apply({
      ...initial,
      state: {
        ...initial.state,
        admittedRequestIds: ["request-1"],
        messages: [{ ...optimistic, id: "entry:2", entryId: "entry:2" }],
      },
    });
    expect(useChatStore.getState().messagesBySession.s1?.map((item) => item.id)).toEqual([
      "entry:2",
    ]);
  });
  it("preserves long loaded history and pagination on a new mount of the same conversation", () => {
    const initial = base(500);
    apply(initial);
    const history = Array.from({ length: 100 }, (_, index) =>
      message(`entry:${index + 1}`, `old ${index}`, `entry:${index + 1}`),
    );
    useChatStore.setState({
      messagesBySession: { s1: history },
      loadedSessions: { s1: true },
      pageCursorBySession: { s1: 1 },
      hasMoreBySession: { s1: true },
    });
    apply({
      ...initial,
      generation: 501,
      revision: 1,
      state: { ...initial.state, messages: [message("entry:101", "newest", "entry:101")] },
    });
    expect(useChatStore.getState().messagesBySession.s1).toHaveLength(101);
    expect(useChatStore.getState().pageCursorBySession.s1).toBe(1);
    expect(useChatStore.getState().hasMoreBySession.s1).toBe(true);
    expect(useChatStore.getState().loadedSessions.s1).toBe(true);
  });

  it("resets and reloads history pagination when native conversation identity changes", async () => {
    const initial = base(510);
    apply(initial);
    useChatStore.setState({
      messagesBySession: { s1: [message("entry:99", "abandoned", "entry:99")] },
      loadedSessions: { s1: true },
      pageCursorBySession: { s1: 80 },
      hasMoreBySession: { s1: false },
      loadingOlderBySession: { s1: true },
    });
    const page = deferred<SessionMessagesPage>();
    const loadMessages = vi.fn(() => page.promise);
    vi.stubGlobal("window", { oint: { sessions: { loadMessages } } });
    try {
      apply({
        ...initial,
        generation: 511,
        revision: 1,
        state: {
          ...initial.state,
          conversationId: 2,
          messages: [message("entry:120", "new branch", "entry:120")],
        },
      });
      expect(useChatStore.getState().messagesBySession.s1?.map((item) => item.id)).toEqual([
        "entry:120",
      ]);
      expect(useChatStore.getState().pageCursorBySession.s1).toBeUndefined();
      expect(useChatStore.getState().loadingOlderBySession.s1).toBeUndefined();
      expect(loadMessages).toHaveBeenCalledWith("s1", { limit: 40, beforeSeq: undefined });
      page.resolve({
        messages: [
          message("entry:10", "inherited", "entry:10"),
          message("entry:120", "new branch", "entry:120"),
        ],
        nextCursor: 10,
        compactionSummaries: [],
      });
      await vi.waitFor(() => expect(useChatStore.getState().pageCursorBySession.s1).toBe(10));
      expect(useChatStore.getState().hasMoreBySession.s1).toBe(true);
      expect(
        useChatStore.getState().messagesBySession.s1?.some((item) => item.id === "entry:99"),
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("discards a stale first history page that began before any native view was mounted", async () => {
    const oldPage = deferred<SessionMessagesPage>();
    const newPage = deferred<SessionMessagesPage>();
    const loadMessages = vi
      .fn()
      .mockImplementationOnce(() => oldPage.promise)
      .mockImplementationOnce(() => newPage.promise);
    vi.stubGlobal("window", { oint: { sessions: { loadMessages } } });
    try {
      const pending = useChatStore.getState().loadMessages("s1");
      const fresh = base(520);
      apply({
        ...fresh,
        state: {
          ...fresh.state,
          conversationId: 3,
          messages: [message("entry:200", "fresh", "entry:200")],
        },
      });
      expect(loadMessages).toHaveBeenCalledTimes(2);
      newPage.resolve({
        messages: [
          message("entry:20", "ancestor", "entry:20"),
          message("entry:200", "fresh", "entry:200"),
        ],
        nextCursor: 20,
        compactionSummaries: [],
      });
      await vi.waitFor(() => expect(useChatStore.getState().pageCursorBySession.s1).toBe(20));
      oldPage.resolve({
        messages: [message("entry:150", "abandoned old result", "entry:150")],
        nextCursor: 150,
        compactionSummaries: [],
      });
      await pending;
      expect(useChatStore.getState().pageCursorBySession.s1).toBe(20);
      expect(useChatStore.getState().messagesBySession.s1?.map((item) => item.id)).toEqual([
        "entry:20",
        "entry:200",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches again when a newer gap arrives while an older snapshot RPC is pending", async () => {
    const initial = base(530);
    apply(initial);
    const first = deferred<ChatLiveSnapshot>();
    const second = deferred<ChatLiveSnapshot>();
    const snapshot = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("window", { oint: { chat: { snapshot } } });
    try {
      const gap = (offset: number) =>
        useChatStore.getState().applyEvent("s1", {
          type: "view",
          frame: {
            generation: initial.generation,
            previousRevision: initial.revision + offset - 1,
            revision: initial.revision + offset,
            ops: [],
          },
        });
      gap(5);
      gap(20);
      expect(snapshot).toHaveBeenCalledTimes(1);
      first.resolve({ ...initial, revision: initial.revision + 5 });
      await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
      const recovered = {
        ...initial,
        revision: initial.revision + 20,
        state: { ...initial.state, messages: [message("live:1:2", "caught up")] },
      };
      second.resolve(recovered);
      await vi.waitFor(() => expect(useChatStore.getState().viewsBySession.s1).toEqual(recovered));
      expect(snapshot).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes a cancelled optimistic input while retaining committed history", () => {
    const optimistic: ChatMessage = {
      id: "queued-request",
      role: "user",
      createdAt: 1,
      parts: [],
      status: "complete",
    };
    const saved = message("entry:5", "saved", "entry:5");
    useChatStore.setState({ messagesBySession: { s1: [saved, optimistic] } });
    useChatStore
      .getState()
      .applyEvent("s1", { type: "input-cancelled", messageId: "queued-request" });
    expect(useChatStore.getState().messagesBySession.s1).toEqual([saved]);
  });
});
