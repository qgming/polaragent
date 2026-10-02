import { describe, expect, it } from "vitest";
import { allowedInPlan } from "./plan-mode";
import { agentModeSection, shouldIncludeDelegationRules } from "./agent-mode-prompt";

describe("plan policy", () => {
  it("fails closed for arbitrary commands, delegation, browser actions and third-party tools", () => {
    for (const tool of ["bash", "write", "edit", "Task", "job_start", "browser_click", "mcp__trusted__read", "plugin_any_read", "future_tool"])
      expect(allowedInPlan(tool), tool).toBe(false);
    for (const tool of ["read", "read_image", "grep", "glob", "ask_user"])
      expect(allowedInPlan(tool), tool).toBe(true);
  });
  it("explains the execution boundary without delegation routing", () => {
    expect(agentModeSection("plan", "zh-CN")).toContain("只读");
    expect(agentModeSection("plan", "zh-CN")).toContain("开始执行");
    expect(shouldIncludeDelegationRules("plan")).toBe(false);
  });
});
