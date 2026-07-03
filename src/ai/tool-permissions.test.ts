import { describe, expect, it } from "vitest";

import { parseAiDecision, reviewToolPermission } from "./tool-permissions";

describe("parseAiDecision", () => {
  it("parses a strict JSON decision", () => {
    expect(
      parseAiDecision('{"allow":true,"reason":"常规项目内命令，风险可接受"}'),
    ).toEqual({
      allow: true,
      reason: "常规项目内命令，风险可接受",
    });
  });

  it("extracts allow and reason from labeled fallback output", () => {
    expect(
      parseAiDecision(`
        审查结果：
        allow: false
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
        {"allow":"true","message":"项目内写文件，允许执行"}
      `),
    ).toEqual({
      allow: true,
      reason: "项目内写文件，允许执行",
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
});
