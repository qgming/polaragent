import type { AgentMessage, Entry, MessageEntry } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { ToolCallPart } from "@/shared/contracts/session";
import { mapEntriesToMessages } from "./message-mapper";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

const USAGE: AssistantMessage["usage"] = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 3,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function messageEntry(id: string, seq: number, message: AgentMessage): MessageEntry {
  return { id, type: "message", parentId: null, seq, timestamp: 1_000 + seq, message };
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: 1_000,
  };
}

function toolResultMessage(
  overrides: Partial<ToolResultMessage> & { toolCallId: string },
): ToolResultMessage {
  return {
    role: "toolResult",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 2_000,
    ...overrides,
  };
}

describe("mapEntriesToMessages", () => {
  it("映射 user/assistant 内容块并把 toolResult 回填到对应调用", () => {
    const entries: Entry[] = [
      messageEntry("u1", 1, { role: "user", content: "你好", timestamp: 1 } satisfies UserMessage),
      messageEntry(
        "a1",
        2,
        assistantMessage([
          { type: "thinking", thinking: "先读文件" },
          { type: "text", text: "我来看看" },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } },
        ]),
      ),
      messageEntry(
        "t1",
        3,
        toolResultMessage({
          toolCallId: "call-1",
          content: [{ type: "text", text: "文件内容" }],
        }),
      ),
    ];

    const { messages, compactionSummaries } = mapEntriesToMessages(entries);

    expect(compactionSummaries).toEqual([]);
    expect(messages).toHaveLength(2);

    expect(messages[0]).toMatchObject({
      id: "u1",
      entryId: "u1",
      role: "user",
      createdAt: 1_001,
      status: "complete",
    });
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "你好" }]);

    const assistant = messages[1];
    expect(assistant).toMatchObject({ id: "a1", entryId: "a1", role: "assistant" });
    expect(assistant?.parts).toEqual([
      { type: "reasoning", text: "先读文件" },
      { type: "text", text: "我来看看" },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "read",
        argsText: '{"path":"a.txt"}',
        args: { path: "a.txt" },
        result: "文件内容",
        isError: false,
        status: "done",
      },
    ]);
    expect(assistant?.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 3,
      totalTokens: 15,
      uncachedInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it("user 图片内容映射为 dataUrl", () => {
    const entries: Entry[] = [
      messageEntry("u1", 1, {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", data: "QUJD", mimeType: "image/png" },
        ],
        timestamp: 1,
      }),
    ];

    const { messages } = mapEntriesToMessages(entries);
    expect(messages[0]?.parts).toEqual([
      { type: "text", text: "看图" },
      { type: "image", mimeType: "image/png", dataUrl: "data:image/png;base64,QUJD" },
    ]);
  });

  it("无结果的调用保持 running，出错结果标记 error", () => {
    const entries: Entry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "toolCall", id: "call-2", name: "bash", arguments: {} },
        ]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-2",
          toolName: "bash",
          content: [{ type: "text", text: "命令失败" }],
          isError: true,
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const parts = messages[0]?.parts as ToolCallPart[];
    expect(parts[0]).toMatchObject({ toolCallId: "call-1", status: "running" });
    expect(parts[0]?.result).toBeUndefined();
    expect(parts[1]).toMatchObject({
      toolCallId: "call-2",
      status: "error",
      isError: true,
      result: "命令失败",
    });
  });

  it("工具的结构化 details 与文本结果并存透传", () => {
    const details = {
      diff: "@@ -1 +1 @@\n-旧\n+新\n",
      patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-旧\n+新\n",
      firstChangedLine: 1,
    };
    const entries: Entry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([
          { type: "toolCall", id: "call-1", name: "edit", arguments: { path: "a.txt" } },
        ]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({
          toolCallId: "call-1",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced 1 block(s) in a.txt." }],
          details,
        }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const part = messages[0]?.parts[0] as ToolCallPart | undefined;
    // 文本照旧进 result；details 不因为文本存在而丢失
    expect(part?.result).toBe("Successfully replaced 1 block(s) in a.txt.");
    expect(part?.details).toEqual(details);
  });

  it("工具未给 details 时不写入该字段", () => {
    const entries: Entry[] = [
      messageEntry(
        "a1",
        1,
        assistantMessage([{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]),
      ),
      messageEntry(
        "t1",
        2,
        toolResultMessage({ toolCallId: "call-1", content: [{ type: "text", text: "内容" }] }),
      ),
    ];

    const { messages } = mapEntriesToMessages(entries);
    const part = messages[0]?.parts[0] as ToolCallPart | undefined;
    expect(part).toBeDefined();
    expect(Object.hasOwn(part ?? {}, "details")).toBe(false);
  });

  it("找不到对应调用的 toolResult 被忽略", () => {
    const entries: Entry[] = [
      messageEntry(
        "t1",
        1,
        toolResultMessage({ toolCallId: "missing", content: [{ type: "text", text: "x" }] }),
      ),
    ];
    expect(mapEntriesToMessages(entries).messages).toEqual([]);
  });

  it("compaction 进摘要、branch_summary/custom 被忽略", () => {
    const entries: Entry[] = [
      {
        id: "c1",
        parentId: null,
        seq: 1,
        timestamp: 1,
        type: "compaction",
        summary: "旧对话摘要",
        retainedTail: [],
        tokensBefore: 100,
        fromHook: false,
      },
      { id: "cu1", parentId: null, seq: 2, timestamp: 2, type: "custom", customType: "note" },
      {
        id: "b1",
        parentId: null,
        seq: 3,
        timestamp: 3,
        type: "branch_summary",
        fromId: null,
        summary: "分支摘要",
        fromHook: false,
      },
      messageEntry("u1", 4, { role: "user", content: "继续", timestamp: 4 }),
    ];

    const { messages, compactionSummaries } = mapEntriesToMessages(entries);
    expect(compactionSummaries).toEqual(["旧对话摘要"]);
    expect(messages.map((message) => message.id)).toEqual(["u1"]);
  });

  it("未知内容块跳过且不抛错", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const weird = {
      ...assistantMessage([{ type: "text", text: "正常文本" }]),
      content: [
        { type: "text", text: "正常文本" },
        { type: "unknown-block", foo: 1 },
      ],
    } as unknown as AgentMessage;

    const entries: Entry[] = [messageEntry("a1", 1, weird)];
    expect(() => mapEntriesToMessages(entries)).not.toThrow();
    expect(mapEntriesToMessages(entries).messages[0]?.parts).toEqual([
      { type: "text", text: "正常文本" },
    ]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("assistant 出错状态带 error 文案", () => {
    const failed: AssistantMessage = {
      ...assistantMessage([{ type: "text", text: "出错了" }]),
      stopReason: "error",
      errorMessage: "网络异常",
    };
    const { messages } = mapEntriesToMessages([messageEntry("a1", 1, failed)]);
    expect(messages[0]).toMatchObject({ status: "error", error: "网络异常" });
  });
});
