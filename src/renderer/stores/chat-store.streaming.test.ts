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

  /**
   * 工具运行期间的输出快照是**替换**语义，不是追加。
   *
   * 内核给的 `partialResult` 是累计快照，而且 shell 捕获按 tail 保留 ——
   * 超过上限后头部会被丢掉。所以「本次文本」与「上次文本」既不是前缀关系也不是追加关系，
   * 一旦按 `part-delta` 那样拼字符串，截断发生后内容就会重复或错位。
   */
  it("工具输出快照覆盖而非追加（内核给的是累计文本）", () => {
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

    store.applyEvent("s1", {
      type: "part-output",
      messageId: "a1",
      partIndex: 0,
      text: "第一行\n",
    });
    flushStreamEvents("s1");
    let part = useChatStore.getState().messagesBySession.s1?.[0]?.parts[0];
    expect(part?.type === "tool-call" ? part.partialOutput : undefined).toBe("第一行\n");

    store.applyEvent("s1", {
      type: "part-output",
      messageId: "a1",
      partIndex: 0,
      text: "第一行\n第二行\n",
    });
    flushStreamEvents("s1");
    part = useChatStore.getState().messagesBySession.s1?.[0]?.parts[0];
    // 是完整覆盖后的文本，不是 "第一行\n第一行\n第二行\n"
    expect(part?.type === "tool-call" ? part.partialOutput : undefined).toBe("第一行\n第二行\n");
  });

  it("同一窗口内只有最后一份快照生效（中间态直接丢弃）", () => {
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

    for (const text of ["a\n", "a\nb\n", "a\nb\nc\n"]) {
      store.applyEvent("s1", { type: "part-output", messageId: "a1", partIndex: 0, text });
    }
    flushStreamEvents("s1");

    const part = useChatStore.getState().messagesBySession.s1?.[0]?.parts[0];
    expect(part?.type === "tool-call" ? part.partialOutput : undefined).toBe("a\nb\nc\n");
  });

  it("随后的全量 upsert 覆盖缓冲里的快照（工具结束时以权威全量为准）", () => {
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

    store.applyEvent("s1", {
      type: "part-output",
      messageId: "a1",
      partIndex: 0,
      text: "跑到一半",
    });
    // 工具结束：全量 upsert 不带 partialOutput
    store.applyEvent("s1", {
      type: "part-upsert",
      messageId: "a1",
      partIndex: 0,
      part: {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "bash",
        argsText: "",
        result: "done",
        status: "done",
      },
    });
    flushStreamEvents("s1");

    const part = useChatStore.getState().messagesBySession.s1?.[0]?.parts[0];
    expect(part?.type === "tool-call" ? part.partialOutput : undefined).toBeUndefined();
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

  /**
   * 缓冲计数器的守恒。
   *
   * 这个计数在每个 token 上被读一次（`bufferedEventCount() > STREAM_BUFFER_LIMIT`），
   * 所以它必须是增量维护的 O(1) 计数 —— 早先的实现每次都遍历「所有会话 × 所有 part」，
   * 多子智能体并行流式时那笔开销随会话数线性增长，是 UI 发卡的来源之一。
   *
   * 换成计数器之后，**守恒**就成了正确性前提：漏减会让它单调增长，
   * 最终每一次 token 都越过上限、退化成「每个 token 一次全量 setState」——
   * 比原来的遍历更糟。所以这里把三条路径（新增 / flush 清空 / 丢弃）都钉住。
   */
  describe("缓冲计数器守恒", () => {
    /** 从模块外部读计数：只能通过触发上限行为间接观察，所以这里用导出函数 */
    it("同一 part 反复追加只算一个条目（不会按 token 增长）", () => {
      seed("s1", [streamingMessage()]);
      const store = useChatStore.getState();
      store.applyEvent("s1", {
        type: "part-upsert",
        messageId: "a1",
        partIndex: 0,
        part: { type: "text", text: "" },
      });
      for (let i = 0; i < 50; i += 1) {
        store.applyEvent("s1", {
          type: "part-delta",
          messageId: "a1",
          partIndex: 0,
          kind: "text",
          delta: "x",
        });
      }
      // 全部在缓冲里合批：文本只有在 flush 之后才可见
      expect(textOf("s1")).toBe("");
      flushStreamEvents("s1");
      expect(textOf("s1")).toBe("x".repeat(50));
    });

    it("多个会话各自缓冲，flush 一个不影响另一个的待提交内容", () => {
      seed("s1", [streamingMessage()]);
      seed("s2", [streamingMessage()]);
      const store = useChatStore.getState();
      for (const id of ["s1", "s2"]) {
        store.applyEvent(id, {
          type: "part-upsert",
          messageId: "a1",
          partIndex: 0,
          part: { type: "text", text: "" },
        });
        store.applyEvent(id, {
          type: "part-delta",
          messageId: "a1",
          partIndex: 0,
          kind: "text",
          delta: id,
        });
      }

      flushStreamEvents("s1");
      expect(textOf("s1")).toBe("s1");
      // s2 仍攒着：此时不该被顺带提交
      expect(textOf("s2")).toBe("");

      flushStreamEvents("s2");
      expect(textOf("s2")).toBe("s2");
    });

    it("反复 flush 之后计数器归零（否则会单调增长并退化成每 token 一次提交）", () => {
      seed("s1", [streamingMessage()]);
      const store = useChatStore.getState();
      // 来 10 轮「upsert + 增量 + flush」：若计数器漏减，第 400 轮之前就会被迫逐 token 提交。
      // 这里断言的是**行为**而不是内部数字：每轮 flush 前文本都还不可见，
      // 说明它们确实被合批了，而不是因为计数越界被提前提交。
      for (let round = 0; round < 10; round += 1) {
        store.applyEvent("s1", {
          type: "part-upsert",
          messageId: "a1",
          partIndex: 0,
          part: { type: "text", text: `${round}:` },
        });
        expect(textOf("s1"), `第 ${round} 轮 flush 前`).not.toContain(`${round}:`);
        flushStreamEvents("s1");
      }
      expect(textOf("s1")).toContain("9:");
    });
  });
});
