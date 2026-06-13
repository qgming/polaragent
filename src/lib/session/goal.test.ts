import { describe, expect, it } from "vitest";

import { DEFAULT_GOAL_MAX_TURNS } from "@/lib/goal/types";
import { GOAL_CONFIG_ENTRY, GOAL_EVENT_ENTRY } from "./entries";
import { replayGoalStateFromEntries } from "./goal";
import type { GoalEvaluation } from "@/lib/goal/types";

const evaluation: GoalEvaluation = {
  complete: false,
  confidence: 0.7,
  decision: "continue",
  progressSummary: "还差测试",
  missingItems: ["运行测试"],
  evidence: ["代码已修改"],
  continuePrompt: "继续运行测试",
  needsUserInput: false,
  reason: "缺少验证证据",
  riskLevel: "medium",
};

const emptyPromptEvaluation: GoalEvaluation = {
  ...evaluation,
  continuePrompt: "",
  decision: "needs_user_input",
  needsUserInput: true,
};

describe("replayGoalStateFromEntries", () => {
  it("restores the latest goal config as ready state", () => {
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "完成目标模式", successCriteria: "构建通过" },
      },
    ]);

    expect(state).toMatchObject({
      goalText: "完成目标模式",
      successCriteria: "构建通过",
      status: "ready",
      maxTurns: DEFAULT_GOAL_MAX_TURNS,
      autoContinueCount: 0,
      evaluatedTurnCount: 0,
    });
  });

  it("restores active runtime statuses as paused", () => {
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "跑一个长任务" },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_started",
          status: "running",
          timestamp: 1000,
          tokenBaseline: 42,
        },
      },
    ]);

    expect(state).toMatchObject({
      status: "paused",
      startedAt: 1000,
      tokenBaseline: 42,
    });
  });

  it("clears stale continue prompts when the latest evaluation has none", () => {
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "补齐目标" },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_continued",
          status: "continuing",
          timestamp: 1000,
          continuePrompt: "旧 prompt",
        },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_evaluated",
          status: "evaluating",
          timestamp: 2000,
          evaluation: emptyPromptEvaluation,
          evaluatedTurnCount: 2,
        },
      },
    ]);

    expect(state?.lastContinuePrompt).toBeUndefined();
    expect(state).toMatchObject({
      status: "paused",
      evaluatedTurnCount: 2,
      lastEvaluation: emptyPromptEvaluation,
    });
  });

  it("restores completed goals with completion time", () => {
    const completedEvaluation: GoalEvaluation = {
      ...evaluation,
      complete: true,
      decision: "complete",
      continuePrompt: "",
    };
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "完成目标" },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_completed",
          status: "completed",
          timestamp: 3000,
          completedAt: 2999,
          evaluation: completedEvaluation,
        },
      },
    ]);

    expect(state).toMatchObject({
      status: "completed",
      completedAt: 2999,
      lastEvaluation: completedEvaluation,
    });
  });

  it("does not revive cleared goals", () => {
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "会被清除" },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_cleared",
          status: "paused",
          timestamp: 4000,
        },
      },
    ]);

    expect(state).toBeNull();
  });

  it("restores a new goal created after a clear event", () => {
    const state = replayGoalStateFromEntries([
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "旧目标" },
      },
      {
        type: "custom",
        customType: GOAL_EVENT_ENTRY,
        data: {
          type: "goal_cleared",
          status: "paused",
          timestamp: 4000,
        },
      },
      {
        type: "custom",
        customType: GOAL_CONFIG_ENTRY,
        data: { goalText: "新目标", constraints: "只改目标模块" },
      },
    ]);

    expect(state).toMatchObject({
      goalText: "新目标",
      constraints: "只改目标模块",
      status: "ready",
    });
  });
});
