import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { resolveReplies } from "./reply-variants";

function msg(
  id: string,
  role: ChatMessage["role"],
  parentId?: string | null,
): ChatMessage {
  return {
    id,
    role,
    createdAt: 1,
    parts: [{ type: "text", text: id }],
    status: "complete",
    ...(parentId === undefined ? {} : { parentId }),
  };
}

describe("resolveReplies", () => {
  // 回归核心：不再截断列表后，两条回复会线性并排显示，必须只留选中的那条
  it("同一父消息下的多条回复只展示一条", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant", "u1"), msg("a2", "assistant", "u1")];
    const { visible, branchByMessageId } = resolveReplies(messages);

    expect(visible.map((m) => m.id)).toEqual(["u1", "a2"]);
    expect(branchByMessageId).toEqual({ a2: { parentId: "u1", index: 1, count: 2 } });
  });

  it("缺省选最新一条（重新生成追加在末尾）", () => {
    const messages = [msg("a1", "assistant", "u1"), msg("a2", "assistant", "u1")];
    expect(resolveReplies(messages).visible.map((m) => m.id)).toEqual(["a2"]);
  });

  it("按选择切到旧回复", () => {
    const messages = [msg("u1", "user"), msg("a1", "assistant", "u1"), msg("a2", "assistant", "u1")];
    const { visible, branchByMessageId } = resolveReplies(messages, { u1: 0 });

    expect(visible.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(branchByMessageId).toEqual({ a1: { parentId: "u1", index: 0, count: 2 } });
  });

  it("选择越界时钳制到边界，不丢消息", () => {
    const messages = [msg("a1", "assistant", "u1"), msg("a2", "assistant", "u1")];
    expect(resolveReplies(messages, { u1: 9 }).visible.map((m) => m.id)).toEqual(["a2"]);
    expect(resolveReplies(messages, { u1: -3 }).visible.map((m) => m.id)).toEqual(["a1"]);
  });

  it("只有一条回复或没有 parentId 时不分组、不给切换入口", () => {
    const single = resolveReplies([msg("u1", "user"), msg("a1", "assistant", "u1")]);
    expect(single.visible.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(single.branchByMessageId).toEqual({});

    const bare = resolveReplies([msg("u1", "user"), msg("a1", "assistant", null)]);
    expect(bare.visible.map((m) => m.id)).toEqual(["u1", "a1"]);
    expect(bare.branchByMessageId).toEqual({});
  });

  it("互不相关的两组分支各自独立", () => {
    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant", "u1"),
      msg("a2", "assistant", "u1"),
      msg("u2", "user"),
      msg("b1", "assistant", "u2"),
      msg("b2", "assistant", "u2"),
    ];
    const { visible, branchByMessageId } = resolveReplies(messages, { u1: 0 });

    expect(visible.map((m) => m.id)).toEqual(["u1", "a1", "u2", "b2"]);
    expect(branchByMessageId).toEqual({
      a1: { parentId: "u1", index: 0, count: 2 },
      b2: { parentId: "u2", index: 1, count: 2 },
    });
  });

  it("用户消息本身不参与分组（同一条用户消息只发一次）", () => {
    const messages = [msg("u1", "user", "p0"), msg("u2", "user", "p0")];
    expect(resolveReplies(messages).visible.map((m) => m.id)).toEqual(["u1", "u2"]);
  });

  it("空列表与不变式：可见条数 = 总条数 − 被折叠的变体数", () => {
    expect(resolveReplies([]).visible).toEqual([]);

    const messages = [
      msg("u1", "user"),
      msg("a1", "assistant", "u1"),
      msg("a2", "assistant", "u1"),
      msg("a3", "assistant", "u1"),
    ];
    expect(resolveReplies(messages).visible).toHaveLength(2);
  });
});
