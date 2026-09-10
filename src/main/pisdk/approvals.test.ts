// approvals 单测：挂起/唤醒、事件发射、历史、取消与去重；AI 审批用假实现，不发网络请求。
import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";
import type { ChatEvent } from "@/shared/contracts/chat";
import type { Settings } from "@/shared/contracts/settings";
import type { AiApprover } from "./ai-approver";
import { type ApprovalService, createApprovalService } from "./approvals";

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "system",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    defaultWorkingDir: null,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    aiApprovalModel: null,
    skillDirs: [],
    disabledSkillNames: [],
    archivedVisible: false,
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
  events: ChatEvent[];
}

function createHarness(options?: {
  settings?: Partial<Settings>;
  aiApprover?: AiApprover;
  settingsError?: boolean;
}): Harness {
  const events: ChatEvent[] = [];
  const service = createApprovalService({
    getSettings: async () => {
      if (options?.settingsError) throw new Error("设置读取失败");
      return makeSettings(options?.settings);
    },
    emit: (event) => events.push(event),
    ...(options?.aiApprover === undefined ? {} : { aiApprover: options.aiApprover }),
  });
  return { service, events };
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
    expect(service.history()[0]).toMatchObject({ decidedBy: "ai", note: "AI：只读命令" });
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

  it("设置读取失败时退回用户审批", async () => {
    const { service, events } = createHarness({ settingsError: true });
    const promise = service.request(makeInput());
    await flush();
    expect(requestedRequest(events).source).toBe("user");
    service.respond(service.pending("s1")[0]?.id ?? "", "deny");
    await expect(promise).resolves.toBe("deny");
  });
});
