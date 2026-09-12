// interactions 单测：挂起/唤醒、去重、未知 id、pending 过滤、会话取消与超时结算。
// 超时用**注入的短 timeoutMs**（不用 fake timers）：服务内部会 timer.unref()，
// 真实短定时器既能测到 unref 路径，也不会让测试进程挂住。

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
import type { AskQuestion, AskRequest } from "@/shared/contracts/interaction";
import { createInteractionService, type InteractionService } from "./interactions";

/** 固定提问内容：一道带选项的题 + 一道只能自由输入的题 */
function makeQuestions(): AskQuestion[] {
  return [
    { id: "q1", header: "数据库", question: "用哪个数据库？", options: ["PostgreSQL", "SQLite"] },
    { id: "q2", header: "文案", question: "文档语气？" },
  ];
}

function makeInput(toolCallId = "call-1", sessionId = "s1") {
  return { sessionId, toolCallId, questions: makeQuestions() };
}

interface Harness {
  service: InteractionService;
  /** 已展开的事件（断言用） */
  events: ChatEvent[];
  /** 原始信封：用来断言事件归属的会话 id */
  envelopes: ChatEventEnvelope[];
}

function createHarness(timeoutMs?: number): Harness {
  const events: ChatEvent[] = [];
  const envelopes: ChatEventEnvelope[] = [];
  const service = createInteractionService({
    emit: (payload) => {
      envelopes.push(payload);
      events.push(payload.event);
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { service, events, envelopes };
}

/** 从事件流里取出 ask-requested 携带的请求 */
function requestedRequest(events: ChatEvent[]): AskRequest {
  const event = events.find((item) => item.type === "ask-requested");
  if (event?.type !== "ask-requested") throw new Error("应已发出 ask-requested");
  return event.request;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createInteractionService", () => {
  it("request 后挂起并可见，respond 唤醒并返回答案", async () => {
    const { service, events, envelopes } = createHarness();
    const promise = service.request(makeInput());

    const pending = service.pending("s1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sessionId).toBe("s1");
    expect(pending[0]?.toolCallId).toBe("call-1");
    expect(pending[0]?.questions).toEqual(makeQuestions());
    expect(typeof pending[0]?.createdAt).toBe("number");

    const request = requestedRequest(events);
    expect(request.id).toBe(pending[0]?.id);
    // 事件带请求所属的会话 id（后台会话的提问也只画在它自己那里）
    expect(envelopes[0]?.sessionId).toBe("s1");
    expect(envelopes[0]?.event.type).toBe("ask-requested");

    service.respond(request.id, {
      outcome: "answered",
      answers: [
        { questionId: "q1", selected: ["PostgreSQL"], text: "顺手加迁移脚本" },
        { questionId: "q2", selected: [], text: "简洁一点" },
      ],
    });
    await expect(promise).resolves.toEqual({
      id: request.id,
      outcome: "answered",
      answers: [
        { questionId: "q1", selected: ["PostgreSQL"], text: "顺手加迁移脚本" },
        { questionId: "q2", selected: [], text: "简洁一点" },
      ],
    });

    expect(service.pending()).toHaveLength(0);
    expect(envelopes.at(-1)?.sessionId).toBe("s1");
    expect(envelopes.at(-1)?.event).toEqual({
      type: "ask-resolved",
      id: request.id,
      outcome: "answered",
    });
  });

  it("同一 toolCallId 未决时去重：拿到同一个 Promise，只发一次 ask-requested", async () => {
    const { service, events } = createHarness();
    const first = service.request(makeInput("same"));
    // 第二次带不同的题目：去重以先登记的请求为准，不能再弹第二张卡
    const second = service.request({
      ...makeInput("same"),
      questions: [{ id: "q9", header: "另一个", question: "会被忽略吗？" }],
    });

    expect(second).toBe(first);
    expect(service.pending()).toHaveLength(1);
    expect(service.pending()[0]?.questions).toEqual(makeQuestions());
    expect(events.filter((item) => item.type === "ask-requested")).toHaveLength(1);

    service.respond(service.pending()[0]?.id ?? "", { outcome: "answered", answers: [] });
    await expect(first).resolves.toMatchObject({ outcome: "answered", answers: [] });
    await expect(second).resolves.toMatchObject({ outcome: "answered", answers: [] });
  });

  it("未知 id 的 respond 只 warn 不抛；已结算后再 respond 同样只 warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service } = createHarness();

    expect(() => service.respond("不存在", { outcome: "answered", answers: [] })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("不存在");

    const promise = service.request(makeInput());
    const id = service.pending()[0]?.id ?? "";
    service.respond(id, { outcome: "answered", answers: [] });
    await promise;

    // 重复点击 / 超时后补交：不能再抛错打断渲染进程
    expect(() => service.respond(id, { outcome: "answered", answers: [] })).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("pending 缺省返回全部，按 sessionId 过滤只留该会话", async () => {
    const { service } = createHarness();
    const first = service.request(makeInput("t1", "s1"));
    const second = service.request(makeInput("t2", "s2"));
    const third = service.request(makeInput("t3", "s1"));

    expect(service.pending()).toHaveLength(3);
    expect(service.pending("s1").map((item) => item.toolCallId)).toEqual(["t1", "t3"]);
    expect(service.pending("s2").map((item) => item.toolCallId)).toEqual(["t2"]);
    expect(service.pending("s3")).toHaveLength(0);

    service.cancelSession("s1");
    service.cancelSession("s2");
    await Promise.all([first, second, third]);
  });

  it("cancelSession 只结算该会话的未决提问，且全部按 cancelled 收尾", async () => {
    const { service, events } = createHarness();
    const first = service.request(makeInput("t1", "s1"));
    const second = service.request(makeInput("t2", "s1"));
    const other = service.request(makeInput("t3", "s2"));
    const firstId = service.pending("s1")[0]?.id;
    const secondId = service.pending("s1")[1]?.id;
    expect(firstId).toBeDefined();
    expect(secondId).toBeDefined();

    service.cancelSession("s1");
    await expect(first).resolves.toEqual({
      id: firstId,
      outcome: "cancelled",
      answers: [],
      note: "运行已停止",
    });
    await expect(second).resolves.toEqual({
      id: secondId,
      outcome: "cancelled",
      answers: [],
      note: "运行已停止",
    });
    expect(service.pending("s1")).toHaveLength(0);
    expect(service.pending("s2")).toHaveLength(1);

    // 另一个会话不受影响，仍可正常作答
    service.respond(service.pending("s2")[0]?.id ?? "", {
      outcome: "answered",
      answers: [{ questionId: "q1", selected: ["SQLite"] }],
    });
    await expect(other).resolves.toMatchObject({ outcome: "answered" });
    expect(events.filter((item) => item.type === "ask-resolved")).toHaveLength(3);
  });

  it("超时按 unanswered 结算（带超时说明），后续补交只 warn 不再二次结算", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, events, envelopes } = createHarness(10);
    const promise = service.request(makeInput());
    const id = service.pending()[0]?.id ?? "";
    expect(service.timeoutMs()).toBe(10);

    const response = await promise;
    expect(response).toMatchObject({ id, outcome: "unanswered", answers: [] });
    expect(response.note).toContain("等待超时");
    expect(service.pending()).toHaveLength(0);
    expect(envelopes.at(-1)?.event).toEqual({ type: "ask-resolved", id, outcome: "unanswered" });

    expect(() => service.respond(id, { outcome: "answered", answers: [] })).not.toThrow();
    expect(events.filter((item) => item.type === "ask-resolved")).toHaveLength(1);
  });
});
