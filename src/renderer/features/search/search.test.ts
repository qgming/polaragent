import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts";
import { findMatches } from "./SessionSearchBar";

/** 构造只含一个文本 part 的消息 */
function textMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: 0,
    parts: [{ type: "text", text }],
    status: "complete",
  };
}

describe("findMatches", () => {
  it("空查询返回空数组", () => {
    expect(findMatches([textMessage("m1", "hello world")], "")).toEqual([]);
    expect(findMatches([textMessage("m1", "hello world")], "   ")).toEqual([]);
  });

  it("大小写不敏感，片段保留原文大小写", () => {
    const matches = findMatches([textMessage("m1", "修复 Login 页抖动")], "login");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.count).toBe(1);
    expect(matches[0]?.snippet).toContain("Login");
  });

  it("多消息多命中计数正确，无命中消息被过滤", () => {
    const matches = findMatches(
      [
        textMessage("m1", "dvh 方案 dvh 方案 dvh"),
        textMessage("m2", "无关内容"),
        textMessage("m3", "见 dvh"),
      ],
      "DVH",
    );
    expect(matches.map((match) => [match.messageId, match.count])).toEqual([
      ["m1", 3],
      ["m3", 1],
    ]);
  });

  it("命中在开头：片段不带前置省略号", () => {
    const text = `dvh${"x".repeat(100)}`;
    const snippet = findMatches([textMessage("m1", text)], "dvh")[0]?.snippet ?? "";
    expect(snippet.startsWith("dvh")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("命中在结尾：片段带前置省略号", () => {
    const text = `${"x".repeat(100)}dvh`;
    const snippet = findMatches([textMessage("m1", text)], "dvh")[0]?.snippet ?? "";
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("dvh")).toBe(true);
  });

  it("命中在中间：两侧都有省略号且长度受限", () => {
    const text = `${"x".repeat(100)}dvh${"y".repeat(100)}`;
    const snippet = findMatches([textMessage("m1", text)], "dvh")[0]?.snippet ?? "";
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("dvh");
    // 24 + 3 + 24 个字符 + 两侧省略号
    expect(snippet.length).toBe(53);
  });

  it("短文本不截断、不加省略号", () => {
    const snippet = findMatches([textMessage("m1", "用 dvh 修复")], "dvh")[0]?.snippet ?? "";
    expect(snippet).toBe("用 dvh 修复");
  });

  it("正则元字符按字面量匹配", () => {
    const matches = findMatches([textMessage("m1", "a+b a+b")], "a+b");
    expect(matches[0]?.count).toBe(2);
  });

  it("非文本 part 不参与匹配，多文本 part 合并统计", () => {
    const reasoningOnly: ChatMessage = {
      id: "m1",
      role: "assistant",
      createdAt: 0,
      parts: [{ type: "reasoning", text: "dvh" }],
      status: "complete",
    };
    expect(findMatches([reasoningOnly], "dvh")).toEqual([]);

    const split: ChatMessage = {
      id: "m2",
      role: "assistant",
      createdAt: 0,
      parts: [
        { type: "text", text: "第一段 dvh" },
        { type: "text", text: "第二段 dvh" },
      ],
      status: "complete",
    };
    expect(findMatches([split], "dvh")[0]?.count).toBe(2);
  });
});
