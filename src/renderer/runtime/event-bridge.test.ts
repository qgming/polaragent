import { describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts";
import { dispatchEvent } from "./event-bridge";

/** ChatEvent 全部 12 种事件各构造一个样本 */
const sampleEvents: ChatEvent[] = [
  { type: "input-admitted", messageId: "request-1", entryId: "entry:1" },
  { type: "approval-resolved", id: "a1", decision: "allow_once" },
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
      event: { type: "input-admitted", messageId: "request-1" },
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
