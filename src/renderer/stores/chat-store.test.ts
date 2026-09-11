import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { planRewrite, useChatStore } from "./chat-store";

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
            messageCount: 0,
          },
          {
            id: "s2",
            title: "旧名字",
            createdAt: 1,
            updatedAt: 1,
            cwd: "",
            archived: false,
            messageCount: 0,
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
});
