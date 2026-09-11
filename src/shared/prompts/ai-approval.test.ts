// AI 审批提示词：内置英文模板、工具调用注入、理由语言跟随界面语言。
import { describe, expect, it } from "vitest";
import {
  AI_APPROVAL_PROMPT,
  AI_APPROVAL_SYSTEM_PROMPT,
  buildAiApprovalPrompt,
} from "./ai-approval";

describe("buildAiApprovalPrompt", () => {
  it("把工具名与参数填进占位符", () => {
    const prompt = buildAiApprovalPrompt({
      toolName: "write",
      argsText: '{"path":"a.ts"}',
      workingDir: "D:/work/demo",
      language: "zh-CN",
    });
    expect(prompt).toContain("Tool: write");
    expect(prompt).toContain('{"path":"a.ts"}');
    expect(prompt).toContain("Working directory: D:/work/demo");
    expect(prompt).not.toContain("{{");
  });

  it("没有工作目录时不追加该行（而不是留一行空的）", () => {
    const prompt = buildAiApprovalPrompt({ toolName: "bash", argsText: "{}", language: "zh-CN" });
    expect(prompt).not.toContain("Working directory");
    expect(prompt).not.toContain("{{");
  });

  it("理由语言跟随界面语言", () => {
    const zh = buildAiApprovalPrompt({ toolName: "bash", argsText: "{}", language: "zh-CN" });
    expect(zh).toContain("written in Simplified Chinese");

    const en = buildAiApprovalPrompt({ toolName: "bash", argsText: "{}", language: "en-US" });
    expect(en).toContain("written in English");
  });

  it("钉死输出形状并给出放行/拒绝判据", () => {
    expect(AI_APPROVAL_PROMPT).toContain('{"allow": boolean, "reason": string}');
    expect(AI_APPROVAL_PROMPT).toContain("when in doubt, set allow: false");
    expect(AI_APPROVAL_PROMPT).toContain("credentials");
    expect(AI_APPROVAL_SYSTEM_PROMPT).toContain("tool-call safety reviewer");
  });
});
