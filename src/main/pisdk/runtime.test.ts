// runtime 单测：只覆盖不依赖真实 harness 的纯逻辑（系统提示、规则模式、单例生命周期）。
// 真实 prompt 往返需要模型服务，留给端到端验收。
import { describe, expect, it } from "vitest";
import type { ToolCallPart } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { createApprovalService } from "./approvals";
import {
  applyToolEnd,
  buildSystemPrompt,
  createChatRuntime,
  deriveRulePattern,
  getChatRuntime,
  type PendingEntry,
  pairEntryWithMessage,
} from "./runtime";
import type { SessionStore } from "./session-store";

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

describe("buildSystemPrompt", () => {
  it("包含工作目录、工作规则与中文回复要求", async () => {
    const prompt = await buildSystemPrompt(makeSettings(), "D:\\workspace\\demo");
    expect(prompt).toContain("D:\\workspace\\demo");
    expect(prompt).toContain("工作规则");
    expect(prompt).toContain("使用简体中文回复用户");
  });

  it("语言为 en-US 时要求英文回复", async () => {
    const prompt = await buildSystemPrompt(makeSettings({ language: "en-US" }), "/tmp/demo");
    expect(prompt).toContain("使用英文回复用户");
  });

  it("AGENTS.md 不可读时仍返回可用提示（不抛错）", async () => {
    await expect(buildSystemPrompt(makeSettings(), "/tmp/demo")).resolves.toBeTypeOf("string");
  });
});

describe("deriveRulePattern", () => {
  it("bash 取命令首词", () => {
    expect(deriveRulePattern("bash", { command: "  git   status  " })).toBe("git");
    expect(deriveRulePattern("bash", {})).toBeUndefined();
  });

  it("write/edit 取路径首段并跳过盘符", () => {
    expect(deriveRulePattern("write", { path: "src/foo.ts" })).toBe("src");
    expect(deriveRulePattern("edit", { path: "D:\\dev\\polaragent\\a.ts" })).toBe("dev");
    expect(deriveRulePattern("write", {})).toBeUndefined();
  });
});


describe("pairEntryWithMessage", () => {
  const assistantEntry = (id: string, parentId: string | null = "u1") => ({
    type: "message",
    id,
    parentId,
    message: { role: "assistant" },
  });
  const userEntry = (id: string, parentId: string | null = null) => ({
    type: "message",
    id,
    parentId,
    message: { role: "user" },
  });
  const assistant = (messageId: string) => ({ messageId, role: "assistant" as const });
  const user = (messageId: string) => ({ messageId, role: "user" as const });

  it("同一角色内部按 FIFO 配对，多轮工具调用不会错配", () => {
    const pending = [assistant("m1"), assistant("m2")];

    expect(pairEntryWithMessage(pending, assistantEntry("e1"))).toEqual({
      messageId: "m1",
      patch: { entryId: "e1", parentId: "u1" },
    });
    expect(pairEntryWithMessage(pending, assistantEntry("e2"))).toEqual({
      messageId: "m2",
      patch: { entryId: "e2", parentId: "u1" },
    });
    expect(pending).toEqual([]);
  });

  // 回归：队列原来只存 id、弹队首，于是先落的用户条目把助手消息挤出去，
  // 助手条目反认领了用户消息 —— 用户消息永远没 entryId（分支按钮不出现），
  // 且重新生成拿到的是助手条目（= 当前 tip），报 "target must differ from the current tip"
  it("按角色配对：助手条目不会认领用户消息", () => {
    const pending = [user("u-msg"), assistant("a-msg")];

    expect(pairEntryWithMessage(pending, userEntry("u-entry"))).toEqual({
      messageId: "u-msg",
      patch: { entryId: "u-entry", parentId: null },
    });
    expect(pairEntryWithMessage(pending, assistantEntry("a-entry", "u-entry"))).toEqual({
      messageId: "a-msg",
      patch: { entryId: "a-entry", parentId: "u-entry" },
    });
    expect(pending).toEqual([]);
  });

  it("toolResult / compaction 之类的条目不吃掉队列位置", () => {
    const pending = [assistant("m1")];
    const toolResult = {
      type: "message",
      id: "e0b",
      parentId: "u1",
      message: { role: "toolResult" },
    };
    const compaction = { type: "compaction", id: "c1", parentId: "u1" };

    expect(pairEntryWithMessage(pending, toolResult)).toBeNull();
    expect(pairEntryWithMessage(pending, compaction)).toBeNull();
    // 队列原封不动，助手条目仍配到它身上
    expect(pending).toEqual([assistant("m1")]);
    expect(pairEntryWithMessage(pending, assistantEntry("e1"))?.messageId).toBe("m1");
  });

  it("没有同角色待配项时返回 null 且不动队列", () => {
    const pending = [assistant("m1")];
    expect(pairEntryWithMessage(pending, userEntry("u-entry"))).toBeNull();
    expect(pending).toEqual([assistant("m1")]);

    const empty: PendingEntry[] = [];
    expect(pairEntryWithMessage(empty, assistantEntry("e1"))).toBeNull();
  });

  it("parentId 为 null（会话首条）也照常带出", () => {
    const pending = [assistant("m1")];
    expect(pairEntryWithMessage(pending, assistantEntry("e1", null))?.patch).toEqual({
      entryId: "e1",
      parentId: null,
    });
  });
});

describe("applyToolEnd", () => {
  /** 流式路径上被写入的那份 part；只填 applyToolEnd 会碰的字段 */
  function makePart(): ToolCallPart {
    return {
      type: "tool-call",
      toolCallId: "call-1",
      toolName: "edit",
      argsText: "{}",
      status: "running",
    };
  }

  it("文本结果与结构化详情并存，状态随 isError", () => {
    const details = { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-旧\n+新\n" };
    const part = makePart();
    applyToolEnd(
      part,
      { content: [{ type: "text", text: "Successfully replaced 1 block(s)" }], details },
      false,
    );

    expect(part.result).toBe("Successfully replaced 1 block(s)");
    // 关键：details 不因为文本存在而丢失（渲染层的 diff 面板全靠它）
    expect(part.details).toEqual(details);
    expect(part.isError).toBe(false);
    expect(part.status).toBe("done");
  });

  it("工具无 details 时不写入该字段", () => {
    const part = makePart();
    // 真实工具可以不带 details（pi 的类型标为必填，运行时却常见缺省），显式给 undefined
    applyToolEnd(part, { content: [{ type: "text", text: "内容" }], details: undefined }, false);

    expect(part.result).toBe("内容");
    expect(Object.hasOwn(part, "details")).toBe(false);
  });

  it("失败时状态为 error 并保留 isError", () => {
    const part = makePart();
    applyToolEnd(
      part,
      { content: [{ type: "text", text: "命令失败" }], details: undefined },
      true,
    );

    expect(part.status).toBe("error");
    expect(part.isError).toBe(true);
  });

  it("无文本时退回 details 作为结果（两者都不丢）", () => {
    const details = { truncation: { truncated: true } };
    const part = makePart();
    applyToolEnd(part, { content: [], details }, false);

    expect(part.result).toEqual(details);
    expect(part.details).toEqual(details);
  });
});

describe("getChatRuntime", () => {
  it("createChatRuntime 注册默认单例，dispose 后复用会报错", async () => {
    const settings = makeSettings();
    const runtime = createChatRuntime({
      getSettings: async () => settings,
      sessionStore: {} as unknown as SessionStore,
      emit: () => undefined,
      approvals: createApprovalService({
        getSettings: async () => settings,
        emit: () => undefined,
      }),
      resolveWorkingDir: async () => process.cwd(),
    });

    expect(getChatRuntime()).toBe(runtime);
    expect(runtime.isRunning("missing")).toBe(false);

    await runtime.dispose();
    expect(() => getChatRuntime()).toThrow("聊天运行时尚未初始化");
  });
});
