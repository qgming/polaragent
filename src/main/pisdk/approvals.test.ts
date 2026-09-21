// approvals 单测：挂起/唤醒、事件发射、历史、取消与去重；AI 审批用假实现，不发网络请求。
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";
import type { ChatEvent, ChatEventEnvelope } from "@/shared/contracts/chat";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import type { AiApprover } from "./ai-approver";
import { type ApprovalService, createApprovalService } from "./approvals";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSubagentNames: [],
    mcpServers: [],
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    disabledSkillNames: [],
    ...overrides,
  };
}

function makeInput(toolCallId = "t1") {
  return {
    sessionId: "s1",
    toolCallId,
    toolName: "write",
    argsText: '{"path":"a.ts"}',
    risk: "high" as const,
  };
}

interface Harness {
  service: ApprovalService;
  /** 已展开的事件（断言用） */
  events: ChatEvent[];
  /** 原始信封：用来断言事件归属的会话 id */
  envelopes: ChatEventEnvelope[];
}

function createHarness(options?: {
  settings?: Partial<Settings>;
  aiApprover?: AiApprover;
  settingsError?: boolean;
}): Harness {
  const events: ChatEvent[] = [];
  const envelopes: ChatEventEnvelope[] = [];
  const service = createApprovalService({
    getSettings: async () => {
      if (options?.settingsError) throw new Error("设置读取失败");
      return makeSettings(options?.settings);
    },
    emit: (payload) => {
      envelopes.push(payload);
      events.push(payload.event);
    },
    ...(options?.aiApprover === undefined ? {} : { aiApprover: options.aiApprover }),
  });
  return { service, events, envelopes };
}

function requestedRequest(events: ChatEvent[]): ApprovalRequest {
  const event = events.find((item) => item.type === "approval-requested");
  if (event?.type !== "approval-requested") throw new Error("应已发出 approval-requested");
  return event.request;
}

/** 让 request() 内部的 await getSettings 微任务先跑完 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("createApprovalService", () => {
  it("request 后挂起并可见，respond 唤醒并记录历史", async () => {
    const { service, events } = createHarness();
    const promise = service.request(makeInput());

    await flush();
    const pending = service.pending("s1");
    expect(pending).toHaveLength(1);
    const request = requestedRequest(events);
    expect(request.sessionId).toBe("s1");
    expect(request.source).toBe("user");
    expect(pending[0]?.id).toBe(request.id);

    service.respond(request.id, "allow_once");
    await expect(promise).resolves.toBe("allow_once");

    expect(service.pending()).toHaveLength(0);
    expect(events.some((item) => item.type === "approval-resolved")).toBe(true);
    expect(service.history()[0]).toMatchObject({
      decision: "allow_once",
      decidedBy: "user",
      request: { id: request.id },
    });
  });

  it("同一 toolCallId 未决时去重", async () => {
    const { service, events } = createHarness();
    const first = service.request(makeInput("same"));
    const second = service.request(makeInput("same"));

    await flush();
    expect(service.pending()).toHaveLength(1);
    expect(events.filter((item) => item.type === "approval-requested")).toHaveLength(1);

    service.respond(service.pending()[0]?.id ?? "", "deny" satisfies ApprovalDecision);
    await expect(first).resolves.toBe("deny");
    await expect(second).resolves.toBe("deny");
  });

  it("cancelSession 按 deny 处理并标记运行已停止", async () => {
    const { service } = createHarness();
    const first = service.request(makeInput("t1"));
    const other = service.request({ ...makeInput("t2"), sessionId: "s2" });

    await flush();
    service.cancelSession("s1");

    await expect(first).resolves.toBe("deny");
    expect(service.pending("s1")).toHaveLength(0);
    expect(service.pending("s2")).toHaveLength(1);
    expect(service.history().some((record) => record.note === "运行已停止")).toBe(true);

    service.respond(service.pending("s2")[0]?.id ?? "", "allow_once");
    await expect(other).resolves.toBe("allow_once");
  });

  it("ai_review 模式下 AI 放行时自动通过", async () => {
    const aiApprover: AiApprover = async () => ({ allow: true, reason: "只读命令" });
    const { service, events } = createHarness({
      settings: { permissionMode: "ai_review" },
      aiApprover,
    });

    await expect(service.request(makeInput())).resolves.toBe("allow_once");
    expect(requestedRequest(events).source).toBe("ai");
    expect(service.pending()).toHaveLength(0);
    expect(service.history()[0]).toMatchObject({ decidedBy: "ai", note: "AI: 只读命令" });
  });

  it("AI 拒绝时仍挂起，等待用户覆盖", async () => {
    const aiApprover: AiApprover = async () => ({ allow: false, reason: "命中危险命令" });
    const { service, events } = createHarness({
      settings: { permissionMode: "ai_review" },
      aiApprover,
    });

    const promise = service.request(makeInput());
    await flush();
    expect(service.pending("s1")).toHaveLength(1);
    expect(requestedRequest(events).reason).toBe("命中危险命令");

    service.respond(service.pending("s1")[0]?.id ?? "", "allow_once");
    await expect(promise).resolves.toBe("allow_once");
  });

  it("非 ai_review 模式或未注入审批器时退回用户", async () => {
    // 未注入审批器：即使处于 ai_review 也由用户处理
    const noApprover = createHarness({ settings: { permissionMode: "ai_review" } });
    const promiseA = noApprover.service.request(makeInput("a"));
    await flush();
    expect(requestedRequest(noApprover.events).source).toBe("user");
    noApprover.service.respond(noApprover.service.pending("s1")[0]?.id ?? "", "deny");
    await expect(promiseA).resolves.toBe("deny");

    // 注入了审批器但模式为默认：不启用 AI 审批
    const aiApprover: AiApprover = async () => ({ allow: true, reason: "不应被调用" });
    const defaultMode = createHarness({ settings: { permissionMode: "default" }, aiApprover });
    const promiseB = defaultMode.service.request(makeInput("b"));
    await flush();
    expect(requestedRequest(defaultMode.events).source).toBe("user");
    defaultMode.service.respond(defaultMode.service.pending("s1")[0]?.id ?? "", "allow_once");
    await expect(promiseB).resolves.toBe("allow_once");
  });

  it("AI 拒绝时把结论交回渲染层（approval-reviewed + aiReviewed）", async () => {
    const aiApprover: AiApprover = async () => ({ allow: false, reason: "命中危险命令" });
    const { service, events } = createHarness({
      settings: { permissionMode: "ai_review" },
      aiApprover,
    });

    const promise = service.request(makeInput());
    await flush();

    const reviewed = events.find((item) => item.type === "approval-reviewed");
    expect(reviewed).toMatchObject({ reason: "命中危险命令" });
    const pending = service.pending("s1")[0];
    expect(pending?.aiReviewed).toBe(true);
    expect(pending?.reason).toBe("命中危险命令");

    // 请求仍在等用户决定
    service.respond(pending?.id ?? "", "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("把工作目录交给 AI 预审（判断操作是否越出项目范围）", async () => {
    let seen: { workingDir?: string } = {};
    const aiApprover: AiApprover = async (input) => {
      seen = { ...(input.workingDir === undefined ? {} : { workingDir: input.workingDir }) };
      return { allow: true, reason: "只读命令" };
    };
    const { service } = createHarness({
      settings: { permissionMode: "ai_review" },
      aiApprover,
    });

    await expect(service.request({ ...makeInput(), workingDir: "D:/work/demo" })).resolves.toBe(
      "allow_once",
    );
    expect(seen.workingDir).toBe("D:/work/demo");
  });

  it("AI 调用失败也把结论交回，用户仍可放行", async () => {
    const aiApprover: AiApprover = async () => {
      throw new Error("网络中断");
    };
    const { service, events } = createHarness({
      settings: { permissionMode: "ai_review" },
      aiApprover,
    });

    const promise = service.request(makeInput());
    await flush();

    const reviewed = events.find((item) => item.type === "approval-reviewed");
    expect(reviewed).toMatchObject({ reason: expect.stringContaining("AI 审批失败") });
    expect(service.pending("s1")[0]?.aiReviewed).toBe(true);

    service.respond(service.pending("s1")[0]?.id ?? "", "allow_once");
    await expect(promise).resolves.toBe("allow_once");
  });

  it("设置读取失败时退回用户审批", async () => {
    const { service, events } = createHarness({ settingsError: true });
    const promise = service.request(makeInput());
    await flush();
    expect(requestedRequest(events).source).toBe("user");
    service.respond(service.pending("s1")[0]?.id ?? "", "deny");
    await expect(promise).resolves.toBe("deny");
  });

  it("事件带上请求所属的会话 id（后台会话的审批也落到它自己头上）", async () => {
    const { service, envelopes } = createHarness();
    const promise = service.request(makeInput("t-bg"));
    await flush();
    expect(envelopes[0]?.sessionId).toBe("s1");
    expect(envelopes[0]?.event.type).toBe("approval-requested");

    service.respond(service.pending("s1")[0]?.id ?? "", "deny");
    await expect(promise).resolves.toBe("deny");
    expect(envelopes.at(-1)?.sessionId).toBe("s1");
    expect(envelopes.at(-1)?.event.type).toBe("approval-resolved");
  });
});
