import { describe, expect, it } from "vitest";
import { AGENT_MODES, normalizeAgentMode } from "@/shared/contracts/common";
import { agentModeSection, shouldIncludeDelegationRules } from "./agent-mode-prompt";

// Guard behavioral boundaries and required capabilities, not the old paragraph layout.
describe("shared working-style prompts", () => {
  it("accepts exactly two working styles", () => {
    expect(AGENT_MODES).toEqual(["standard", "orchestrate"]);
    expect(normalizeAgentMode("plan")).toBeNull();
    expect(normalizeAgentMode("standard")).toBe("standard");
  });

  it.each(AGENT_MODES)("%s keeps common capabilities, constraints and communication", (mode) => {
    const prompt = agentModeSection(mode, "zh-CN");
    for (const token of [
      "Oint",
      "{{cwd}}",
      "通用助手",
      "写作与文档",
      "调研与综合",
      "进展",
      "使用简体中文回复用户",
    ])
      expect(prompt).toContain(token);
    for (const tool of [
      "read_workflow",
      "create_goal",
      "update_goal",
      "read_plan",
      "save_plan",
      "present_plan",
      "set_work_contract",
    ])
      expect(prompt).toContain(tool);
    for (const field of [
      "Goal",
      "Plan",
      "Todo",
      "Task",
      "effects",
      "requiresReview",
      "pendingInputIds",
      "approvedPlanRef",
      "requirementsChanged",
    ])
      expect(prompt).toContain(field);
    expect(prompt).toContain("所有验收标准达成");
    expect(prompt).toContain("暂停目标只能由用户显式恢复");
    expect(prompt).toContain("不能自行批准");
    expect(prompt).toContain("不构成方案修订");
    expect(prompt).toContain("不额外增加确认");
    expect(prompt).not.toContain("先问一次");
    expect(prompt).not.toContain("计划模式");
    expect(prompt).not.toContain("切换模式");
    expect(agentModeSection(mode, "en-US")).toContain("使用英文回复用户");
  });

  it("standard acts directly while orchestrate delegates useful independent work", () => {
    const standard = agentModeSection("standard", "zh-CN");
    const orchestrate = agentModeSection("orchestrate", "zh-CN");
    expect(standard).not.toBe(orchestrate);
    expect(standard).toContain("默认直接完成任务");
    expect(orchestrate).toContain("编排者");
    expect(orchestrate).toContain("委派能改善质量");
    expect(orchestrate).toContain("整合可以自己完成");
    expect(orchestrate).not.toContain("四者缺一");
    expect(orchestrate).not.toContain("一律派给");
    expect(orchestrate).not.toContain("## 委派（子智能体）");
  });

  it("only orchestrate adds detailed delegation guidance", () => {
    expect(shouldIncludeDelegationRules("orchestrate")).toBe(true);
    expect(shouldIncludeDelegationRules("standard")).toBe(false);
  });
});
