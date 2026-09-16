import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/shared/contracts/session";
import { clearStreamBuffer, flushStreamEvents, useChatStore } from "./chat-store";

/** 一条正在流式的助手消息：只有一个空文本 part，等待增量填充 */
function streamingMessage(id = "a1"): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: 1,
    parts: [{ type: "text", text: "" }],
    status: "streaming",
  };
}

function seed(sessionId: string, messages: ChatMessage[]): void {
  useChatStore.setState((state) => ({
    activeSessionId: sessionId,
    messagesBySession: { ...state.messagesBySession, [sessionId]: messages },
  }));
}

function textOf(sessionId: string, messageIndex = 0): string | undefined {
  const message = useChatStore.getState().messagesBySession[sessionId]?.[messageIndex];
  const part = message?.parts[0];
  return part?.type === "text" ? part.text : undefined;
}

describe("流式事件合帧缓冲", () => {
  beforeEach(() => {
    clearStreamBuffer("s1");
    clearStreamBuffer("s2");
    useChatStore.setState({ activeSessionId: "s1", messagesBySession: {} });
  });

  it("多个增量在 flush 前不触碰 store，一次 flush 合并提交", () => {
    seed("s1", [streamingMessage()]);
    const store = useChatStore.getState();
    // 创建 part（空文本）+ 一串增量：全部进缓冲
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: { type: "text", text: "" },
    });
    const listener = vi.fn();
    const unsubscribe = useChatStore.subscribe(listener);
    for (const chunk of ["你", "好", "，", "世界"]) {
      store.applyEvent("s1", {
        type: "part-delta",
        messageId: "a1",
        partIndex: 0,
        kind: "text",
        delta: chunk,
      });
    }
    // 缓冲期内：store 一个字都没动，也没有触发任何订阅回调
    expect(textOf("s1")).toBe("");
    expect(listener).not.toHaveBeenCalled();

    flushStreamEvents("s1");
    expect(textOf("s1")).toBe("你好，世界");
    // 四条增量 + 一次 upsert 合批成一次状态提交
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("收尾全量（text_end 那条 upsert）覆盖此前缓冲的增量", () => {
    seed("s1", [streamingMessage()]);
    const store = useChatStore.getState();
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: { type: "text", text: "abc" },
    });
    store.applyEvent("s1", {
      type: "part-delta",
      messageId: "a1",
      partIndex: 0,
      kind: "text",
      delta: "def",
    });
    // 收尾全量：权威文本，之前的增量（已在其中）作废
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: { type: "text", text: "abcdef" },
    });
    flushStreamEvents("s1");
    expect(textOf("s1")).toBe("abcdef");
  });

  it("工具参数增量落在 argsText 上", () => {
    seed("s1", [
      {
        id: "a1",
        role: "assistant",
        createdAt: 1,
        parts: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "bash",
            argsText: "",
            status: "running",
          },
        ],
        status: "streaming",
      },
    ]);
    const store = useChatStore.getState();
    for (const chunk of ['{"cmd"', ':"ls"', "}"]) {
      store.applyEvent("s1", {
        type: "part-delta",
        messageId: "a1",
        partIndex: 0,
        kind: "args",
        delta: chunk,
      });
    }
    flushStreamEvents("s1");
    const part = useChatStore.getState().messagesBySession.s1?.[0]?.parts[0];
    expect(part?.type === "tool-call" ? part.argsText : undefined).toBe('{"cmd":"ls"}');
  });

  it("缺少创建事件（增量没有可落的 part）时不写坏 store", () => {
    seed("s1", [streamingMessage()]);
    const store = useChatStore.getState();
    // 下标 3 的增量：既没有 upsert 也没有对应 part —— 属于缺口
    expect(() => {
      store.applyEvent("s1", {
        type: "part-delta",
        messageId: "a1",
        partIndex: 3,
        kind: "text",
        delta: "孤儿增量",
      });
      flushStreamEvents("s1");
    }).not.toThrow();
    // 缺口不猜测内容：store 保持原样（真实修复走快照重同步，见 resyncStream）
    expect(textOf("s1")).toBe("");
    expect(useChatStore.getState().messagesBySession.s1?.[0]?.parts).toHaveLength(1);
  });

  it("消息不存在（错过 message-added）时同样只标记缺口，不凭空建消息", () => {
    seed("s1", []);
    const store = useChatStore.getState();
    expect(() => {
      store.applyEvent("s1", {
        type: "part-delta",
        messageId: "missing",
        partIndex: 0,
        kind: "text",
        delta: "x",
      });
      flushStreamEvents("s1");
    }).not.toThrow();
    expect(useChatStore.getState().messagesBySession.s1).toEqual([]);
  });

  it("按会话隔离：flush 指定会话时不提交别的会话", () => {
    seed("s1", [streamingMessage("m1")]);
    seed("s2", [streamingMessage("m2")]);
    const store = useChatStore.getState();
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "m1",
      partIndex: 0,
      part: { type: "text", text: "S1" },
    });
    store.applyEvent("s2", {
      type: "part-upsert",
      messageId: "m2",
      partIndex: 0,
      part: { type: "text", text: "S2" },
    });

    flushStreamEvents("s1");
    expect(textOf("s1")).toBe("S1");
    // s2 攒着的事件还没提交
    expect(textOf("s2")).toBe("");

    flushStreamEvents();
    expect(textOf("s2")).toBe("S2");
  });

  it("结构事件到达前先落定 part 缓冲（消息结束时文本不会少一截）", () => {
    seed("s1", [streamingMessage()]);
    const store = useChatStore.getState();
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: { type: "text", text: "" },
    });
    store.applyEvent("s1", {
      type: "part-delta",
      messageId: "a1",
      partIndex: 0,
      kind: "text",
      delta: "最后一段",
    });
    store.applyEvent("s1", {
      type: "message-updated",
      messageId: "a1",
      patch: { status: "complete" },
    });
    // 同一次 set 调用链里：文本已经落定，状态也是 complete
    expect(textOf("s1")).toBe("最后一段");
    expect(useChatStore.getState().messagesBySession.s1?.[0]?.status).toBe("complete");
  });

  it("clearStreamBuffer 丢弃待提交事件（截断/删会话后旧内容不会被拼回来）", () => {
    seed("s1", [streamingMessage()]);
    const store = useChatStore.getState();
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: { type: "text", text: "旧回复" },
    });
    clearStreamBuffer("s1");
    flushStreamEvents("s1");
    expect(textOf("s1")).toBe("");
  });
});
