import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "@/shared/contracts";
import { dispatchEvent } from "./event-bridge";

/** ChatEvent 全部 10 种事件各构造一个样本 */
const sampleEvents: ChatEvent[] = [
  { type: "run-started", runId: "r1" },
  {
    type: "message-added",
    message: { id: "m1", role: "assistant", createdAt: 1, parts: [], status: "complete" },
  },
  { type: "part-upsert", messageId: "m1", partIndex: 0, part: { type: "text", text: "hi" } },
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
  { type: "compaction-started" },
  { type: "compaction-ended", summaryPreview: "sum" },
  { type: "run-ended", runId: "r1", reason: "stop" },
];

describe("dispatchEvent", () => {
  it("把各种事件类型原样转发给 onEvent（绑定当前会话 id）", () => {
    const onEvent = vi.fn();
    for (const event of sampleEvents) {
      dispatchEvent(() => "s1", onEvent, event);
    }
    expect(onEvent).toHaveBeenCalledTimes(sampleEvents.length);
    for (const [index, event] of sampleEvents.entries()) {
      expect(onEvent.mock.calls[index]).toEqual(["s1", event]);
    }
  });

  it("无活动会话时跳过转发", () => {
    const onEvent = vi.fn();
    dispatchEvent(() => null, onEvent, { type: "run-started", runId: "r1" });
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("未知事件类型不抛错", () => {
    const onEvent = vi.fn();
    const unknown = { type: "unknown-event", payload: 1 } as unknown as ChatEvent;
    expect(() => dispatchEvent(() => "s1", onEvent, unknown)).not.toThrow();
    expect(onEvent).toHaveBeenCalledWith("s1", unknown);
  });
});
