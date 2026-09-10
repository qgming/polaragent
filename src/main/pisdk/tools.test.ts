import { describe, expect, it } from "vitest";
import { buildTools, TOOL_NAMES } from "./tools";

describe("buildTools", () => {
  it("返回 bash/read/write/edit 四个结构完整的工具", () => {
    const tools = buildTools();

    expect(tools).toHaveLength(4);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "read", "write"]);
    expect(new Set(tools.map((tool) => tool.name))).toEqual(new Set(Object.values(TOOL_NAMES)));

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parameters).toBeTruthy();
      expect(typeof tool.execute).toBe("function");
    }
  });
});
