import { describe, expect, it } from "vitest";

import { parseAiDecision, reviewToolPermission } from "./tool-permissions";

describe("parseAiDecision", () => {
  it("parses a strict JSON decision", () => {
    expect(
      parseAiDecision('{"deny":false,"reason":"常规项目内命令，风险可接受"}'),
    ).toEqual({
      allow: true,
      reason: "常规项目内命令，风险可接受",
    });
  });

  it("extracts deny and reason from labeled fallback output", () => {
    expect(
      parseAiDecision(`
        审查结果：
        deny: true
        reason: 递归删除项目根目录，高危操作
      `),
    ).toEqual({
      allow: false,
      reason: "递归删除项目根目录，高危操作",
    });
  });

  it("reads allow from non-boolean JSON fields when they are text", () => {
    expect(
      parseAiDecision(`
        {"deny":"false","message":"项目内写文件，允许执行"}
      `),
    ).toEqual({
      allow: true,
      reason: "项目内写文件，允许执行",
    });
  });

  it("repairs single-quote and bare-key JSON-like responses", () => {
    expect(
      parseAiDecision(`
        {deny: 'true', reason: '递归删除用户目录，高危操作',}
      `),
    ).toEqual({
      allow: false,
      reason: "递归删除用户目录，高危操作",
    });
  });

  it("infers allow from chinese verdict text when json is missing", () => {
    expect(
      parseAiDecision(`
        审查结论：允许
        原因：项目目录内常规构建命令，风险可接受
      `),
    ).toEqual({
      allow: true,
      reason: "项目目录内常规构建命令，风险可接受",
    });
  });

  it("infers deny from free-form chinese safety explanation", () => {
    expect(
      parseAiDecision("建议拒绝执行。该命令会递归删除系统关键目录，存在不可逆风险。"),
    ).toEqual({
      allow: false,
      reason: "建议拒绝执行。该命令会递归删除系统关键目录，存在不可逆风险",
    });
  });

  it("returns an explicit deny reason when allow field is missing but risk text exists", () => {
    expect(
      parseAiDecision("该操作涉及系统目录，存在不可逆风险，建议阻止执行。"),
    ).toEqual({
      allow: false,
      reason: "该操作涉及系统目录，存在不可逆风险，建议阻止执行",
    });
  });

  it("defaults to allow when no explicit veto is present", () => {
    expect(parseAiDecision("嗯，我需要更多信息。"))
      .toEqual({
        allow: true,
        reason: "AI 审批未给出明确允许或拒绝结论，按默认放行处理。",
      });
  });

  it("returns a clear fallback reason when AI explicitly vetoes without usable reason", () => {
    expect(parseAiDecision('{"deny":true}')).toEqual({
      allow: false,
      reason: "AI 审批给出了拒绝结论，但未提供具体风险点；已按拒绝结论阻止执行。",
    });
  });
});

describe("reviewToolPermission", () => {
  // 安全说明：以下两个用例反映 C1 / H1 / H3 修复后的行为：
  //   render_widget 不再 LOW_RISK 自动放行（C1）—— 内联 HTML 在 iframe 渲染
  //     是代码执行入口，必须走 AI 审查。
  //   delete_file 不再"工作目录内自动放行"（H3）—— workingDir 为空时
  //     isWithinWorkingDir 返回 false，delete_file 一律走 AI 审查。
  // 由于测试环境没有可用模型服务，reviewWithAi 会直接返回拒绝（allow:false），
  // 这两条测试因而断言"不再自动放行"而非具体审查结论。
  it("sends render_widget to AI review in ai_review mode (not auto-allowed)", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "render_widget",
      input: { title: "demo_widget", update_mode: "replace" },
      permissionMode: "ai_review",
    });
    expect(decision.allow).toBe(false);
  });

  it("sends delete_file to AI review in ai_review mode (not auto-allowed)", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "delete_file",
      input: { path: "src/tmp.txt" },
      permissionMode: "ai_review",
      workingDir: "D:/dev/polaragent",
    });
    expect(decision.allow).toBe(false);
  });

  it("sends write_file to AI review in ai_review mode (not auto-allowed)", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "write_file",
      input: { path: "approval-lab/demo.txt", content: "hello" },
      permissionMode: "ai_review",
      workingDir: "D:/dev/polaragent",
    });
    expect(decision.allow).toBe(false);
  });

  it("sends create_directory to AI review in ai_review mode (not auto-allowed)", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "create_directory",
      input: { path: "approval-lab/new-dir" },
      permissionMode: "ai_review",
      workingDir: "D:/dev/polaragent",
    });
    expect(decision.allow).toBe(false);
  });

  it("still auto-allows read-only tools in ai_review mode", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "read_file",
      input: { path: "README.md" },
      permissionMode: "ai_review",
      workingDir: "D:/dev/polaragent",
    });
    expect(decision).toEqual({ allow: true });
  });

  it("still auto-allows session-only interaction tools in ai_review mode", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "update_todos",
      input: { action: "add", todos: [{ text: "审批测试", done: false }] },
      permissionMode: "ai_review",
    });
    expect(decision).toEqual({ allow: true });
  });

  it("still rejects delete_file in ai_review mode when workingDir is empty (H3)", async () => {
    // H3 修复：workingDir 为空时不允许自动放行；应走 AI 审查
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "delete_file",
      input: { path: "/etc/passwd" },
      permissionMode: "ai_review",
      // workingDir 故意省略
    });
    expect(decision.allow).toBe(false);
  });

  it("rewrites generic deny reasons into specific safe-mode command explanations", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "run_bash",
      input: { command: "git reset --hard HEAD" },
      permissionMode: "safe",
    });

    expect(decision).toEqual({
      allow: false,
      reason: "安全模式下，命令「git reset --hard HEAD」包含 git reset --hard，会强制丢弃当前工作区改动。",
    });
  });

  it("returns path-specific deny reasons for safe delete_file", async () => {
    const decision = await reviewToolPermission({
      agentId: "agent-1",
      requesterName: "助手",
      threadId: "thread-1",
      toolName: "delete_file",
      input: { path: "C:/Windows/System32" },
      permissionMode: "safe",
      workingDir: "D:/dev/polaragent",
    });

    expect(decision).toEqual({
      allow: false,
      reason: "安全模式下，目标路径「C:/Windows/System32」不在工作目录「D:/dev/polaragent」内；删除操作仅允许在工作目录内执行。",
    });
  });
});
