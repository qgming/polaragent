import { describe, expect, it } from "vitest";
import { buildTools, TOOL_NAMES } from "./tools";

/** 内核原生四件套：description 由 tools.ts 整体覆盖 */
const NATIVE_TOOLS = ["bash", "read", "write", "edit"];
/** 自建只读工具 */
const CUSTOM_TOOLS = ["grep", "glob", "todo"];

describe("buildTools", () => {
  it("返回内核四件套 + 三个自建只读工具的完整工具集", () => {
    const tools = buildTools();

    expect(tools).toHaveLength(NATIVE_TOOLS.length + CUSTOM_TOOLS.length);
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...NATIVE_TOOLS, ...CUSTOM_TOOLS].sort(),
    );
    expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(Object.values(TOOL_NAMES)));

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
      // label 是 AgentTool 的必填字段，UI 直接拿它显示
      expect(tool.label).toBeTruthy();
    }
  });

  it("四个原生工具的 description 已覆盖为带场景指导的文案", () => {
    // 内核自带的文案只有操作说明，模型选错工具的首要原因就是缺「什么时候用」——
    // 这条断言防止将来有人把覆盖去掉（去掉后 description 仍在，只是变得没用）
    const tools = buildTools().filter((tool) => NATIVE_TOOLS.includes(tool.name));

    expect(tools).toHaveLength(NATIVE_TOOLS.length);
    for (const tool of tools) {
      expect(tool.description).toContain("什么时候用");
      expect(tool.description).toContain("什么时候不要用");
    }
  });

  it("自建工具的 name 与 label 一致", () => {
    const tools = buildTools();
    for (const name of CUSTOM_TOOLS) {
      const tool = tools.find((candidate) => candidate.name === name);
      expect(tool, `缺少工具 ${name}`).toBeTruthy();
      expect(tool?.label).toBe(name);
    }
  });
});
