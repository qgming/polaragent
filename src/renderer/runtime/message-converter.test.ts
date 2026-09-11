import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts";
import { appendMessageToImages, appendMessageToText, toThreadMessage } from "./message-converter";

/** 构造最小可用的 AppendMessage（user 消息） */
function makeAppend(content: AppendMessage["content"]): AppendMessage {
  return {
    role: "user",
    content,
    createdAt: new Date(),
    metadata: { custom: {} },
    parentId: null,
    sourceId: null,
    runConfig: undefined,
  };
}

const baseMessage: ChatMessage = {
  id: "m1",
  role: "assistant",
  createdAt: 1_700_000_000_000,
  parts: [],
  status: "complete",
};

describe("toThreadMessage", () => {
  it("映射 text / reasoning / image part", () => {
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        { type: "text", text: "你好" },
        { type: "reasoning", text: "思考中" },
        { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
      ],
    };
    const thread = toThreadMessage(message);
    expect(thread.content).toEqual([
      { type: "text", text: "你好" },
      { type: "reasoning", text: "思考中" },
      { type: "image", image: "data:image/png;base64,AAAA" },
    ]);
  });

  it("映射 tool-call part（含 args / result / isError）", () => {
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "read_file",
          argsText: '{"path":"a.ts"}',
          args: { path: "a.ts" },
          result: "file content",
          isError: false,
          status: "done",
        },
      ],
    };
    const thread = toThreadMessage(message);
    expect(thread.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read_file",
        argsText: '{"path":"a.ts"}',
        args: { path: "a.ts" },
        result: "file content",
        isError: false,
      },
    ]);
  });

  it("工具 details 映射到 assistant-ui 的 artifact 槽位", () => {
    const details = { diff: "@@ -1 +1 @@\n-旧\n+新\n", patch: "--- a/a.ts\n+++ b/a.ts\n" };
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "edit",
          argsText: '{"path":"a.ts"}',
          result: "Successfully replaced 1 block(s)",
          details,
          status: "done",
        },
      ],
    };
    const thread = toThreadMessage(message);
    // details 与 result 并存；自造字段会被归一化丢掉，只能走 artifact
    expect(thread.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "edit",
        argsText: '{"path":"a.ts"}',
        result: "Successfully replaced 1 block(s)",
        artifact: details,
      },
    ]);
  });

  it("工具无 details 时不写 artifact", () => {
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-3",
          toolName: "read",
          argsText: "{}",
          result: "内容",
          status: "done",
        },
      ],
    };
    const part = toThreadMessage(message).content?.[0];
    expect(part).toBeDefined();
    // content 允许是字符串，先收窄成对象再看字段
    expect(typeof part === "object" && part !== null && "artifact" in part).toBe(false);
  });

  it("映射 role / id / createdAt", () => {
    const thread = toThreadMessage({ ...baseMessage, role: "user" });
    expect(thread.role).toBe("user");
    expect(thread.id).toBe("m1");
    expect(thread.createdAt).toEqual(new Date(1_700_000_000_000));
  });

  it("status 三态映射：streaming → running / error → incomplete / complete → stop", () => {
    expect(toThreadMessage({ ...baseMessage, status: "streaming" }).status).toEqual({
      type: "running",
    });
    expect(toThreadMessage({ ...baseMessage, status: "error", error: "boom" }).status).toEqual({
      type: "incomplete",
      reason: "error",
      error: "boom",
    });
    expect(toThreadMessage({ ...baseMessage, status: "complete" }).status).toEqual({
      type: "complete",
      reason: "stop",
    });
  });

  // 回归：assistant-ui 对 user 消息带 status 会抛错并导致整树白屏
  it("user 消息不带 status", () => {
    expect(toThreadMessage({ ...baseMessage, role: "user", status: "complete" }).status).toBe(
      undefined,
    );
  });
});

describe("appendMessageToText", () => {
  it("提取全部 text part 并拼接", () => {
    const append = makeAppend([
      { type: "text", text: "你好" },
      { type: "text", text: "世界" },
    ]);
    expect(appendMessageToText(append)).toBe("你好世界");
  });

  it("忽略图片等非文本 part", () => {
    const append = makeAppend([
      { type: "image", image: "data:image/png;base64,AAAA" },
      { type: "text", text: "hi" },
    ]);
    expect(appendMessageToText(append)).toBe("hi");
  });

  it("纯图片消息返回空串", () => {
    const append = makeAppend([{ type: "image", image: "data:image/png;base64,AAAA" }]);
    expect(appendMessageToText(append)).toBe("");
  });
});

describe("appendMessageToImages", () => {
  it("dataUrl 拆出 mimeType 与 base64 数据", () => {
    const append = makeAppend([{ type: "image", image: "data:image/png;base64,QUJD" }]);
    expect(appendMessageToImages(append)).toEqual([{ data: "QUJD", mimeType: "image/png" }]);
  });

  it("非 dataUrl 原样透传并给默认 mimeType", () => {
    const append = makeAppend([{ type: "image", image: "rawbase64" }]);
    expect(appendMessageToImages(append)).toEqual([
      { data: "rawbase64", mimeType: "application/octet-stream" },
    ]);
  });

  it("忽略文本 part", () => {
    const append = makeAppend([{ type: "text", text: "hi" }]);
    expect(appendMessageToImages(append)).toEqual([]);
  });
});
