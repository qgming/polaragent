import { describe, expect, it } from "vitest";

import { parseGoalEvaluation } from "./goal-evaluator";

describe("parseGoalEvaluation", () => {
  it("normalizes a completed evaluation", () => {
    const evaluation = parseGoalEvaluation(`
      {
        "complete": true,
        "confidence": 0.92,
        "progressSummary": "构建和测试已通过",
        "missingItems": [],
        "evidence": ["npm run build passed", "npm test passed"],
        "continuePrompt": "  ",
        "needsUserInput": false,
        "reason": "验收条件都有证据",
        "riskLevel": "low"
      }
    `);

    expect(evaluation).toMatchObject({
      complete: true,
      confidence: 0.92,
      decision: "complete",
      evidence: ["npm run build passed", "npm test passed"],
      continuePrompt: "",
      riskLevel: "low",
    });
  });

  it("infers needs_user_input from legacy fields", () => {
    const evaluation = parseGoalEvaluation(`
      {
        "complete": false,
        "confidence": 1.7,
        "progressSummary": "需要确认范围",
        "missingItems": ["等待用户确认是否修改数据库"],
        "evidence": [],
        "continuePrompt": "",
        "needsUserInput": true,
        "reason": "缺少用户决策",
        "riskLevel": "unknown"
      }
    `);

    expect(evaluation).toMatchObject({
      complete: false,
      confidence: 1,
      decision: "needs_user_input",
      needsUserInput: true,
      riskLevel: "medium",
    });
  });

  it("extracts JSON from fenced or noisy responses", () => {
    const evaluation = parseGoalEvaluation(`
      \`\`\`json
      {
        "complete": false,
        "confidence": 0.4,
        "decision": "blocked",
        "progressSummary": "权限阻塞",
        "missingItems": ["等待权限"],
        "evidence": ["命令连续返回 permission denied"],
        "continuePrompt": "",
        "needsUserInput": false,
        "reason": "继续自动执行无效",
        "riskLevel": "high"
      }
      \`\`\`
    `);

    expect(evaluation).toMatchObject({
      complete: false,
      decision: "blocked",
      missingItems: ["等待权限"],
      riskLevel: "high",
    });
  });
});
