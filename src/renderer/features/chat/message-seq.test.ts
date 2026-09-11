import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { isMessageSequenceSynced } from "./message-seq";

/** 只关心 id 与角色的轻量构造：判据只看这两个字段 */
function withIds(...ids: string[]): ChatMessage[] {
  return ids.map((id) => ({
    id,
    role: "user",
    createdAt: 0,
    parts: [{ type: "text", text: id }],
    status: "complete",
  }));
}

/** 渲染侧只要 id */
function rendered(...ids: string[]): { id: string }[] {
  return ids.map((id) => ({ id }));
}

describe("isMessageSequenceSynced", () => {
  it("两条空序列视为同步", () => {
    expect(isMessageSequenceSynced([], [])).toBe(true);
  });

  it("逐条同 id 同顺序时同步", () => {
    expect(isMessageSequenceSynced(withIds("m1", "m2"), rendered("m1", "m2"))).toBe(true);
  });

  it("长度不同时不同步（切换会话的中间帧：旧会话消息更多）", () => {
    expect(isMessageSequenceSynced(withIds("m1", "m2", "m3"), rendered("m1", "m2"))).toBe(false);
    expect(isMessageSequenceSynced(withIds("m1"), rendered("m1", "m2"))).toBe(false);
  });

  it("长度相同但 id 不同时不同步（切换会话的中间帧：两个会话消息数恰好相同）", () => {
    expect(isMessageSequenceSynced(withIds("a1", "a2"), rendered("b1", "b2"))).toBe(false);
  });

  it("长度与首项都相同、但后续不同时不同步 —— fork 会话与源会话共用 id，仅比长度或首项会漏判", () => {
    // 源会话 [m1, m2, m3] 与 fork 出来的 [m1, m2, m4]：长度与首项都相同
    expect(isMessageSequenceSynced(withIds("m1", "m2", "m3"), rendered("m1", "m2", "m4"))).toBe(
      false,
    );
  });

  it("顺序不同时不同步", () => {
    expect(isMessageSequenceSynced(withIds("m1", "m2"), rendered("m2", "m1"))).toBe(false);
  });

  describe("运行中的尾部乐观助手消息", () => {
    it("放行时：渲染侧恰好多一条即视为同步", () => {
      expect(
        isMessageSequenceSynced(withIds("m1", "m2"), rendered("m1", "m2", "optimistic"), true),
      ).toBe(true);
    });

    it("放行时也要求前 N 条逐条同 id，不能拿「切会话那一帧」蒙混", () => {
      expect(
        isMessageSequenceSynced(withIds("m1", "m2"), rendered("a1", "a2", "optimistic"), true),
      ).toBe(false);
    });

    it("放行时多出两条仍不同步（只可能多一条乐观消息）", () => {
      expect(isMessageSequenceSynced(withIds("m1"), rendered("m1", "o1", "o2"), true)).toBe(false);
    });

    it("放行时渲染侧与 store 等长即为未同步（该条件下运行时必定注入，等长说明还没走到那一帧）", () => {
      expect(isMessageSequenceSynced(withIds("m1", "m2"), rendered("m1", "m2"), true)).toBe(false);
    });

    it("不放行时多出一条即为不同步（这正是原来漏滚的那一档）", () => {
      expect(
        isMessageSequenceSynced(withIds("m1", "m2"), rendered("m1", "m2", "optimistic"), false),
      ).toBe(false);
    });

    it("空 store 加一条乐观消息在放行时同步（新会话刚开始运行）", () => {
      expect(isMessageSequenceSynced([], rendered("optimistic"), true)).toBe(true);
    });
  });
});
