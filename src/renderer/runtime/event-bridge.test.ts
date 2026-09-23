import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts";
import { dispatchEvent } from "./event-bridge";

/** ChatEvent 全部 12 种事件各构造一个样本 */
const sampleEvents: ChatEvent[] = [
  { type: "run-started", runId: "r1" },
  {
    type: "message-added",
    message: { id: "m1", role: "assistant", createdAt: 1, parts: [], status: "complete" },
  },
  { type: "part-upsert", messageId: "m1", partIndex: 0, part: { type: "text", text: "hi" } },
  { type: "part-delta", messageId: "m1", partIndex: 0, kind: "text", delta: "!" },
  { type: "message-updated", messageId: "m1", patch: { status: "complete" } },
  { type: "queue-updated", items: [{ id: "q1", text: "t", mode: "steer" }] },
  {
    type: "approval-requested",
    request: {
      id: "a1",
      sessionId: "s1",
      toolName: "bash",
      argsText: "{}",
      risk: "low",
      source: "user",
    },
  },
  { type: "approval-resolved", id: "a1", decision: "allow_once" },
  { type: "approval-reviewed", id: "a1", reason: "命中危险命令" },
  { type: "compaction-started", reason: "manual", startedAt: 1 },
  {
    type: "compaction-ended",
    reason: "threshold",
    status: "completed",
    endedAt: 2,
    summaryPreview: "sum",
    tokensBefore: 120_000,
    retainedCount: 12,
  },
  { type: "run-ended", runId: "r1", reason: "stop" },
  { type: "session-titled", sessionId: "s1", title: "修复登录超时" },
];

describe("dispatchEvent", () => {
  it("按信封里的会话 id 原样转发事件", () => {
    const onEvent = vi.fn();
    for (const event of sampleEvents) {
      dispatchEvent(onEvent, { sessionId: "s1", event });
    }
    expect(onEvent).toHaveBeenCalledTimes(sampleEvents.length);
    for (const [index, event] of sampleEvents.entries()) {
      expect(onEvent.mock.calls[index]).toEqual(["s1", event]);
    }
  });

  // 这一条正是「切走的会话还在跑」的关键：归属来自主进程的信封，与当前打开的是谁无关
  it("后台会话的事件落在它自己的会话上", () => {
    const onEvent = vi.fn();
    const envelope: ChatEventEnvelope = {
      sessionId: "s-bg",
      event: { type: "run-started", runId: "r1" },
    };
    dispatchEvent(onEvent, envelope);
    expect(onEvent).toHaveBeenCalledWith("s-bg", envelope.event);
  });

  it("未知事件类型不抛错", () => {
    const onEvent = vi.fn();
    const unknown = { type: "unknown-event", payload: 1 } as unknown as ChatEvent;
    expect(() => dispatchEvent(onEvent, { sessionId: "s1", event: unknown })).not.toThrow();
    expect(onEvent).toHaveBeenCalledWith("s1", unknown);
  });
});
