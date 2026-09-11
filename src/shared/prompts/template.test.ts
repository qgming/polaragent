// 提示词模板：占位符替换、重复替换、缺失键兜底。
import { describe, expect, it } from "vitest";
import { renderPrompt } from "./template";

describe("renderPrompt", () => {
  it("按名字替换占位符，允许花括号内有空格", () => {
    expect(renderPrompt("Tool: {{tool_name}} / {{ tool_name }}", { tool_name: "bash" })).toBe(
      "Tool: bash / bash",
    );
  });

  it("缺失的键替换为空串，不抛错也不留占位符", () => {
    const rendered = renderPrompt("A{{missing}}B", {});
    expect(rendered).toBe("AB");
    expect(rendered).not.toContain("{{");
  });

  it("不碰正文里的单个花括号与其它模板语法", () => {
    expect(renderPrompt('{"allow": true}', {})).toBe('{"allow": true}');
    // 只认 {{...}}：单花括号与 [[...]] 都原样保留
    expect(renderPrompt("[[not_a_placeholder]]", {})).toBe("[[not_a_placeholder]]");
    expect(renderPrompt("{single}", {})).toBe("{single}");
  });
});
