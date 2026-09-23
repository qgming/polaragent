import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { mergeLoadedPage, planRewrite, useChatStore } from "./chat-store";

function msg(id: string, role: ChatMessage["role"], parentId?: string | null): ChatMessage {
  return {
    id,
    role,
    createdAt: 1,
    parts: [{ type: "text", text: id }],
    status: "complete",
    ...(parentId === undefined ? {} : { parentId }),
  };
}

/** 一条典型的会话：用户消息 u1 的父级是 p0，其回复是 a1 */
const CONVERSATION = [
  msg("p0", "user", null),
  msg("u1", "user", "p0"),
  msg("a1", "assistant", "u1"),
];

describe("planRewrite", () => {
  // 核心：回退点必须是这条用户消息的**父**条目。
  // 回退到它自己（或不回退）会让旧回复留在 tip 路径上 ——
  // 那样 fork 新会话时新旧回复会一起被复制过去，正是要修的症状。
  it("回退点是该用户消息的父条目，不是它自己", () => {
    const plan = planRewrite(CONVERSATION, 1, "resend");
    expect(plan).toEqual({ keepCount: 2, rewindTo: "p0", reuseId: "u1" });
  });

  it("resend 保留这条用户消息并复用它 id（文本没变，原地替换不闪）", () => {
    expect(planRewrite(CONVERSATION, 1, "resend")).toEqual({
      keepCount: 2,
      rewindTo: "p0",
      reuseId: "u1",
    });
  });

  // 回归：编辑时这条已被移出列表，若还拿「列表末尾那条」的 id 去复用，
  // 会把新用户消息顶到前一条助手消息上（顶掉它）。所以复用 id 只由 plan 显式给出，编辑时为 null。
  it("edit 移除这条并不复用 id（文本变了，不该顶掉别的消息）", () => {
    expect(planRewrite(CONVERSATION, 1, "edit")).toEqual({
      keepCount: 1,
      rewindTo: "p0",
      reuseId: null,
    });
  });

  it("首条用户消息的父级是 null，照样允许替换（回退到会话开头）", () => {
    const plan = planRewrite(CONVERSATION, 0, "resend");
    expect(plan).toEqual({ keepCount: 1, rewindTo: null, reuseId: "p0" });
  });

  // 回归：父级未知时拼 null 会被当成「回退到会话开头」，
  // 把整段历史从 tip 上摘掉 —— 列表看着还在，模型那边已经清零
  it("父级未知（尚未落盘）时拒绝，而不是当成会话开头", () => {
    const optimistic = [msg("p0", "user", null), msg("u1", "user")];
    expect(planRewrite(optimistic, 1, "resend")).toBeNull();
    expect(planRewrite(optimistic, 1, "edit")).toBeNull();
  });

  it("不是用户消息时拒绝", () => {
    expect(planRewrite(CONVERSATION, 2, "resend")).toBeNull();
    expect(planRewrite([], 0, "resend")).toBeNull();
  });

  describe("applyEvent 的 session-titled", () => {
    function seedSessions() {
      useChatStore.setState({
        sessions: [
          {
            id: "s1",
            title: null,
            createdAt: 1,
            updatedAt: 2,
            cwd: "",
            archived: false,
            pinned: false,
            messageCount: 0,
            model: null,
          },
          {
            id: "s2",
            title: "旧名字",
            createdAt: 1,
            updatedAt: 1,
            cwd: "",
            archived: false,
            pinned: false,
            messageCount: 0,
            model: null,
          },
        ],
      });
    }

    it("按事件自带的会话 id 就地替换标题，其它会话不受影响", () => {
      seedSessions();
      useChatStore.getState().applyEvent("s1", {
        type: "session-titled",
        sessionId: "s1",
        title: "修复登录超时",
      });
      const sessions = useChatStore.getState().sessions;
      expect(sessions.find((item) => item.id === "s1")?.title).toBe("修复登录超时");
      expect(sessions.find((item) => item.id === "s2")?.title).toBe("旧名字");
    });

    it("会话不在列表里时安静忽略", () => {
      seedSessions();
      expect(() =>
        useChatStore.getState().applyEvent("missing", {
          type: "session-titled",
          sessionId: "missing",
          title: "新名字",
        }),
      ).not.toThrow();
      expect(useChatStore.getState().sessions.map((item) => item.id)).toEqual(["s1", "s2"]);
    });
  });

  describe("运行状态按会话独立", () => {
    it("后台会话运行中时不影响当前会话，跑完各自清零", () => {
      useChatStore.setState({
        sessions: [
          {
            id: "s1",
            title: "前台",
            createdAt: 1,
            updatedAt: 2,
            cwd: "",
            archived: false,
            pinned: false,
            messageCount: 0,
            model: null,
          },
          {
            id: "s2",
            title: "后台",
            createdAt: 1,
            updatedAt: 1,
            cwd: "",
            archived: false,
            pinned: false,
            messageCount: 0,
            model: null,
          },
        ],
        activeSessionId: "s1",
        runningBySession: {},
        queueBySession: {},
      });

      const store = useChatStore.getState();
      store.applyEvent("s2", { type: "run-started", runId: "r2" });
      expect(useChatStore.getState().runningBySession.s2).toBe(true);
      expect(useChatStore.getState().runningBySession.s1).toBeUndefined();

      // 后台跑完：只清它自己；顺带触发的列表刷新在测试环境里没有 IPC，异常要被吞掉
      expect(() =>
        store.applyEvent("s2", { type: "run-ended", runId: "r2", reason: "completed" }),
      ).not.toThrow();
      expect(useChatStore.getState().runningBySession.s2).toBe(false);
      expect(useChatStore.getState().activeSessionId).toBe("s1");
    });
  });
});

describe("mergeLoadedPage", () => {
  const msg = (id: string, entryId?: string): ChatMessage => ({
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", text: id }],
    status: "complete",
    ...(entryId === undefined ? {} : { entryId }),
  });

  it("没有事件累积时原样返回磁盘历史", () => {
    const page = [msg("m1"), msg("m2")];
    expect(mergeLoadedPage(page, [])).toEqual(page);
  });

  it("事件累积里同 id 的消息被历史那版取代", () => {
    const merged = mergeLoadedPage([msg("m1")], [msg("m1")]);
    expect(merged.map((item) => item.id)).toEqual(["m1"]);
  });

  it("id 不同但 entryId 相同的消息不重复（两边的 id 不一定一致）", () => {
    const merged = mergeLoadedPage([msg("from-disk", "e1")], [msg("from-event", "e1")]);
    expect(merged).toEqual([msg("from-disk", "e1")]);
  });

  it("还在流式（没有 entryId）的消息接在历史后面，不会被丢掉", () => {
    const streaming: ChatMessage = {
      id: "live",
      role: "assistant",
      createdAt: 2,
      parts: [{ type: "text", text: "写了一半" }],
      status: "streaming",
    };
    const merged = mergeLoadedPage([msg("m1")], [streaming]);
    expect(merged.map((item) => item.id)).toEqual(["m1", "live"]);
  });
});

/**
 * 压缩状态机：`/compact`（手动）与内核的自动压缩共用同一套事件。
 *
 * 两条不变式在这里钉住：
 * 1. **四种结局必须分开落** —— 早先失败的结局也被写成「进行中」，顶部会永久显示运行中；
 * 2. **乐观态可以被事件覆盖，但事件不会被过期的失败结果覆盖** —— 手动压缩的 IPC 返回
 *    可能晚于内核事件到达（压缩已经跑完了），那时不能把刚出现的摘要抹掉。
 */
describe("压缩状态机", () => {
  const SESSION_ID = "s1";

  function seed() {
    useChatStore.setState({
      sessions: [
        {
          id: SESSION_ID,
          title: "会话",
          createdAt: 1,
          updatedAt: 1,
          cwd: "",
          archived: false,
          pinned: false,
          messageCount: 0,
          model: null,
        },
      ],
      activeSessionId: SESSION_ID,
      compactions: {},
    });
  }

  /** 事件驱动的四个分支 */
  it("compaction-started：按 reason 落成进行中，并带上开始时间", () => {
    seed();
    useChatStore
      .getState()
      .applyEvent(SESSION_ID, { type: "compaction-started", reason: "threshold", startedAt: 100 });
    expect(useChatStore.getState().compactions[SESSION_ID]).toEqual({
      phase: "running",
      reason: "threshold",
      startedAt: 100,
    });
  });

  it("completed：带上摘要、压缩前 tokens 与保留条数", () => {
    seed();
    const store = useChatStore.getState();
    store.applyEvent(SESSION_ID, { type: "compaction-started", reason: "manual", startedAt: 100 });
    store.applyEvent(SESSION_ID, {
      type: "compaction-ended",
      reason: "manual",
      status: "completed",
      endedAt: 200,
      summaryPreview: "摘要预览",
      tokensBefore: 123_456,
      retainedCount: 7,
    });
    expect(useChatStore.getState().compactions[SESSION_ID]).toEqual({
      phase: "completed",
      reason: "manual",
      startedAt: 100,
      endedAt: 200,
      summaryPreview: "摘要预览",
      tokensBefore: 123_456,
      retainedCount: 7,
    });
  });

  // 回归：这一条正是「压缩失败后顶部永久转圈」的成因
  it("failed：落成失败并带原因，绝不停在「进行中」", () => {
    seed();
    const store = useChatStore.getState();
    store.applyEvent(SESSION_ID, { type: "compaction-started", reason: "manual", startedAt: 100 });
    store.applyEvent(SESSION_ID, {
      type: "compaction-ended",
      reason: "manual",
      status: "failed",
      endedAt: 200,
      summaryPreview: "",
      error: "模型超时",
    });
    const state = useChatStore.getState().compactions[SESSION_ID];
    expect(state?.phase).toBe("failed");
    expect(state?.error).toBe("模型超时");
  });

  it("declined / aborted 都归到「已取消」", () => {
    for (const status of ["declined", "aborted"] as const) {
      seed();
      useChatStore.getState().applyEvent(SESSION_ID, {
        type: "compaction-ended",
        reason: "threshold",
        status,
        endedAt: 200,
        summaryPreview: "",
      });
      expect(useChatStore.getState().compactions[SESSION_ID]?.phase).toBe("cancelled");
    }
  });

  it("没有 started 事件时（例如刚订阅就收到结束）也能落一个完整状态", () => {
    seed();
    useChatStore.getState().applyEvent(SESSION_ID, {
      type: "compaction-ended",
      reason: "threshold",
      status: "completed",
      endedAt: 200,
      summaryPreview: "s",
    });
    expect(useChatStore.getState().compactions[SESSION_ID]).toMatchObject({
      phase: "completed",
      startedAt: 200,
    });
  });

  it("clearCompaction：只清当前会话（完成态由用户点掉，失败/取消同理）", () => {
    seed();
    useChatStore.setState({
      compactions: {
        [SESSION_ID]: { phase: "failed", reason: "manual", startedAt: 1 },
        s2: { phase: "completed", reason: "manual", startedAt: 1 },
      },
    });
    useChatStore.getState().clearCompaction();
    expect(useChatStore.getState().compactions[SESSION_ID]).toBeUndefined();
    expect(useChatStore.getState().compactions.s2).toBeDefined();
  });

  describe("compact()（手动压缩的动作）", () => {
    it("先写乐观态（IPC 往返期间界面不能毫无反应），成功后交给事件收尾", async () => {
      seed();
      let release: ((value: { ok: true }) => void) | undefined;
      const pending = new Promise<{ ok: true }>((resolve) => {
        release = resolve;
      });
      vi.stubGlobal("window", {
        oint: { chat: { compact: () => pending } },
      });
      try {
        const call = useChatStore.getState().compact("保留数据库相关的讨论");
        expect(useChatStore.getState().compactions[SESSION_ID]?.phase).toBe("running");
        release?.({ ok: true });
        await expect(call).resolves.toEqual({ ok: true });
        // 内核事件还没到：乐观态先留着（真值以内核事件为准）
        expect(useChatStore.getState().compactions[SESSION_ID]?.phase).toBe("running");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("被拒时收成失败，并把结果对象交回调用方（文案由上层按 code 决定）", async () => {
      seed();
      const outcome = { ok: false as const, code: "nothing" as const, message: "没有可压缩的历史" };
      vi.stubGlobal("window", { oint: { chat: { compact: async () => outcome } } });
      try {
        await expect(useChatStore.getState().compact()).resolves.toEqual(outcome);
        const state = useChatStore.getState().compactions[SESSION_ID];
        expect(state?.phase).toBe("failed");
        expect(state?.error).toBe("没有可压缩的历史");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("内核事件先到（压缩已经跑完）时，迟到的失败结果不覆盖它", async () => {
      seed();
      let reject: (() => void) | undefined;
      const pending = new Promise<{ ok: false; code: "busy"; message: string }>((resolve) => {
        reject = () => resolve({ ok: false, code: "busy", message: "会话正忙" });
      });
      vi.stubGlobal("window", { oint: { chat: { compact: () => pending } } });
      try {
        const call = useChatStore.getState().compact();
        // 事件先到：这一轮压缩已经完成
        useChatStore.getState().applyEvent(SESSION_ID, {
          type: "compaction-ended",
          reason: "manual",
          status: "completed",
          endedAt: 200,
          summaryPreview: "摘要",
        });
        reject?.();
        await call;
        expect(useChatStore.getState().compactions[SESSION_ID]).toMatchObject({
          phase: "completed",
          summaryPreview: "摘要",
        });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
