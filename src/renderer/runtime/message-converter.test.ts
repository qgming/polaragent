import type { AppendMessage } from "@assistant-ui/react";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/shared/contracts";
import { appendMessageToAttachments } from "./attachment-payload";
import { appendMessageToText, toThreadMessage } from "./message-converter";

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

  /**
   * 嵌套是 assistant-ui 自己的契约（ToolCallMessagePart.messages），不是我们发明的字段：
   * Task 调用通过它承载整条子会话转录，渲染侧由 PartPrimitive.Messages 直接消费。
   * 平铺的 part 在树的遍历里到不了子会话，所以这里必须真的挂上。
   */
  it("Task 工具调用把子会话转录挂成嵌套消息", () => {
    const child: ChatMessage = {
      ...baseMessage,
      id: "child-1",
      parts: [{ type: "text", text: "子智能体的回复" }],
    };
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "Task",
          argsText: "{}",
          details: { delegationId: "call-1", childSessionId: "child-1" },
          status: "done",
        },
      ],
    };
    const resolveChild = (childSessionId: string): readonly ChatMessage[] | undefined =>
      childSessionId === "child-1" ? [child] : undefined;

    const part = toThreadMessage(message, resolveChild).content?.[0];
    expect(part).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      // 嵌套挂在「派发它的那次调用」上：parentId 用 toolCallId，而不是子消息 id
      parentId: "call-1",
      messages: [
        {
          id: "child-1",
          role: "assistant",
          content: [{ type: "text", text: "子智能体的回复" }],
        },
      ],
    });
  });

  /**
   * 取不到转录时必须**一个键都不写**：库的树遍历用 `part.messages?.length` 判断有没有嵌套，
   * `messages: undefined` 与根本没有 `messages` 在快照 / 克隆里是两种形状。
   * 缺省 resolver（单参数调用）也走这条：现有调用方依赖它保持平铺。
   */
  it("解析不到子会话（undefined / 空数组 / 缺省 resolver）时不写 messages", () => {
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "Task",
          argsText: "{}",
          details: { delegationId: "call-1", childSessionId: "child-1" },
          status: "done",
        },
      ],
    };

    const converted = [
      toThreadMessage(message),
      toThreadMessage(message, () => undefined),
      toThreadMessage(message, () => []),
    ];
    for (const thread of converted) {
      const part = thread.content?.[0];
      expect(part).toBeDefined();
      // content 允许是字符串，先收窄成对象再看键
      const keys = typeof part === "object" && part !== null ? Object.keys(part) : [];
      expect(keys).not.toContain("messages");
      expect(keys).not.toContain("parentId");
    }
  });

  /**
   * 子会话转录里可能留下嵌套的 Task 调用（白名单现在禁止再派，但盘上的转录是既成事实）。
   * resolveChild 必须往下传，否则第二层会退化成平铺 —— 与主线程上的形状不一致。
   */
  it("递归：子消息里的 Task 调用再挂一层", () => {
    const grandchild: ChatMessage = {
      ...baseMessage,
      id: "grandchild-1",
      parts: [{ type: "text", text: "孙子会话的回复" }],
    };
    const child: ChatMessage = {
      ...baseMessage,
      id: "child-1",
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "Task",
          argsText: "{}",
          details: { delegationId: "call-2", childSessionId: "child-2" },
          status: "done",
        },
      ],
    };
    const message: ChatMessage = {
      ...baseMessage,
      parts: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "Task",
          argsText: "{}",
          details: { delegationId: "call-1", childSessionId: "child-1" },
          status: "done",
        },
      ],
    };
    const resolveChild = (childSessionId: string): readonly ChatMessage[] | undefined => {
      if (childSessionId === "child-1") return [child];
      if (childSessionId === "child-2") return [grandchild];
      return undefined;
    };

    const outer = toThreadMessage(message, resolveChild).content?.[0];
    expect(outer).toMatchObject({
      type: "tool-call",
      parentId: "call-1",
      messages: [
        {
          id: "child-1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "call-2",
              // 第二层的 parentId 是它自己那次调用：每一层都归到派发它的 toolCallId
              parentId: "call-2",
              messages: [
                {
                  id: "grandchild-1",
                  role: "assistant",
                  content: [{ type: "text", text: "孙子会话的回复" }],
                },
              ],
            },
          ],
        },
      ],
    });
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

/**
 * 附件提取的回归测试。
 *
 * 这里钉住的是那次「图片从来没发出去」的根因：**附件不在 `message.content` 里**，
 * 而在与它并列的 `message.attachments` 上。任何只扫 content 的写法都会静默返回空数组 ——
 * 界面上不显示、模型也收不到，而没有任何一处报错。
 */
describe("appendMessageToAttachments", () => {
  /** 附件负载所在的 data part（与 attachment-adapter 写进去的形状一致） */
  function dataAttachment(payload: unknown, status: "complete" | "requires-action" = "complete") {
    return {
      id: "a1",
      type: "file",
      name: "shot.png",
      status:
        status === "complete"
          ? { type: "complete" as const }
          : { type: "requires-action" as const, reason: "composer-send" as const },
      content: [{ type: "data" as const, name: "oint.attachment", data: payload }],
    };
  }

  const PAYLOAD = {
    kind: "image" as const,
    name: "shot.png",
    mimeType: "image/png",
    size: 2048,
    path: "D:\\proj\\shot.png",
    images: [{ mimeType: "image/png", data: "QUJD" }],
  };

  it("从 attachments 字段取出附件（而不是从 content）", () => {
    const append: AppendMessage = {
      ...makeAppend([{ type: "text", text: "看这张图" }]),
      attachments: [dataAttachment(PAYLOAD)] as never,
    };
    expect(appendMessageToAttachments(append)).toEqual([PAYLOAD]);
  });

  it("content 里没有附件时返回空数组 —— 这就是旧实现恒为空的原因", () => {
    const append: AppendMessage = {
      ...makeAppend([{ type: "text", text: "看这张图" }]),
      attachments: [dataAttachment(PAYLOAD)] as never,
    };
    // 旧实现扫的是 content：那里只有文本，于是永远取不到图
    expect(append.content).toEqual([{ type: "text", text: "看这张图" }]);
    expect(appendMessageToAttachments(append)).toHaveLength(1);
  });

  it("没有 attachments 字段时返回空数组", () => {
    expect(appendMessageToAttachments(makeAppend([{ type: "text", text: "hi" }]))).toEqual([]);
  });

  it("已有负载的附件一律带上，不看它停在哪个状态上", () => {
    // 宁可发出去，也不要因为状态没推到位而静默丢掉用户贴的文件。
    // 真正「还没探测完」的形状是**没有 content**（见下一条），那种情况由适配器的
    // pending 表在 send() 里兜住，不靠这里过滤。
    const append: AppendMessage = {
      ...makeAppend([]),
      attachments: [dataAttachment(PAYLOAD, "requires-action")] as never,
    };
    expect(appendMessageToAttachments(append)).toEqual([PAYLOAD]);
  });

  it("还没有负载（探测中）的附件取不到东西", () => {
    const append: AppendMessage = {
      ...makeAppend([]),
      attachments: [
        {
          id: "a3",
          type: "file",
          name: "shot.png",
          status: { type: "running", reason: "uploading", progress: 0 },
          file: {},
        },
      ] as never,
    };
    expect(appendMessageToAttachments(append)).toEqual([]);
  });

  it("负载形状不对时忽略，不抛错", () => {
    const append: AppendMessage = {
      ...makeAppend([]),
      attachments: [dataAttachment({ nope: true })] as never,
    };
    expect(appendMessageToAttachments(append)).toEqual([]);
  });

  it("旧形状兜底：图片直接放在 content 里的 image part 也能取到", () => {
    const append: AppendMessage = {
      ...makeAppend([]),
      attachments: [
        {
          id: "a2",
          type: "image",
          name: "legacy.png",
          status: { type: "complete" },
          content: [{ type: "image", image: "data:image/png;base64,QUJD" }],
        },
      ] as never,
    };
    expect(appendMessageToAttachments(append)).toEqual([
      {
        kind: "image",
        name: "image",
        mimeType: "image/png",
        size: 0,
        images: [{ mimeType: "image/png", data: "QUJD" }],
      },
    ]);
  });
});
