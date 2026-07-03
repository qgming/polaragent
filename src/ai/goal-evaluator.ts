// 目标检测器
// src/ai/goal-evaluator.ts
//
// 调用 LLM 判断当前任务是否完成目标，并生成续跑 prompt。
// 使用统一轻量调用层，跟随设置中的 provider 路由配置。

import { callLlm } from "./llm-call";
import { resolveModelService, firstModelService } from "./model-router";
import type { GoalEvaluation } from "@/lib/goal/types";

interface EvaluationContext {
  goalText: string;
  successCriteria?: string;
  constraints?: string;
  lastAssistantContent: string;
  todos: Array<{ content: string; status: string }>;
  artifacts: Array<{ name: string; kind: string }>;
  autoContinueCount: number;
  evaluatedTurnCount: number;
  maxTurns?: number;
  maxTokens?: number;
  tokenSpend?: number;
  maxRuntimeMinutes?: number;
  runtimeMinutes?: number;
}

const SYSTEM_PROMPT = [
  "你是一个独立的任务目标评估器。你的职责是在每一轮 Agent 输出后，判断用户设定的目标是否已经达到，并给出下一步控制决策。",
  "你只根据对话中已经出现的证据、待办、工具结果摘要和产物清单判断。不要假设文件、测试或命令已经成功，除非最近输出或上下文中出现了可验证证据。",
  "",
  "你必须只输出纯 JSON 对象（不要包含代码块标记），格式如下：",
  "{",
  '  "complete": true,',
  '  "confidence": 0.85,',
  '  "decision": "complete",',
  '  "progressSummary": "已完成用户登录功能的实现和测试",',
  '  "missingItems": [],',
  '  "evidence": ["单元测试全部通过", "登录页面可正常使用"],',
  '  "continuePrompt": "",',
  '  "needsUserInput": false,',
  '  "reason": "所有核心功能已实现并通过验证",',
  '  "riskLevel": "low"',
  "}",
  "",
  "字段说明：",
  '- complete: 布尔值，目标是否完成',
  '- confidence: 0.0-1.0 的数值，表示判断信心',
  '- decision: "complete" | "continue" | "needs_user_input" | "blocked" | "budget_exhausted"',
  '- progressSummary: 一句话总结当前进度',
  '- missingItems: 字符串数组，列出未完成的事项',
  '- evidence: 字符串数组，列出支持判断的具体证据',
  '- continuePrompt: 如未完成，生成续跑提示词引导继续工作',
  '- needsUserInput: 是否需要用户介入',
  '- reason: 判断理由',
  '- riskLevel: "low" | "medium" | "high"',
  "",
  "规则：",
  "- complete=true 仅当目标的核心要求都已满足",
  "- complete=true 时 evidence 必须列出具体证据",
  "- 如果完成标准要求测试/构建通过，但上下文没有对应结果，complete 必须为 false",
  "- continuePrompt 必须是可直接发送给 Agent 的自然语言指令",
  "- 只输出 JSON，不要包含任何其他内容",
].join("\n");

function buildUserPrompt(ctx: EvaluationContext): string {
  const parts: string[] = [];
  parts.push("【目标】" + ctx.goalText);
  if (ctx.successCriteria) {
    parts.push("【完成标准】" + ctx.successCriteria);
  }
  if (ctx.constraints) {
    parts.push("【执行约束】" + ctx.constraints);
  }
  if (ctx.todos.length > 0) {
    const lines = ctx.todos.map((t) => "  - [" + t.status + "] " + t.content);
    parts.push("【当前待办】\n" + lines.join("\n"));
  }
  if (ctx.artifacts.length > 0) {
    const lines = ctx.artifacts.map((a) => "  - " + a.name + " (" + a.kind + ")");
    parts.push("【已产出文件】\n" + lines.join("\n"));
  }
  const truncated = ctx.lastAssistantContent.slice(0, 3000);
  parts.push("【最近一轮助手输出】\n" + (truncated || "(无正文输出)"));
  parts.push("【运行统计】\n" + [
    "  - 已自动续跑: " + ctx.autoContinueCount + " 次",
    "  - 已评估轮数: " + ctx.evaluatedTurnCount + " 次",
    ctx.maxTurns ? "  - 最大轮数: " + ctx.maxTurns : undefined,
    typeof ctx.tokenSpend === "number" ? "  - 估算 token 消耗: " + ctx.tokenSpend : undefined,
    ctx.maxTokens ? "  - 最大 token: " + ctx.maxTokens : undefined,
    typeof ctx.runtimeMinutes === "number" ? "  - 已运行分钟: " + ctx.runtimeMinutes.toFixed(1) : undefined,
    ctx.maxRuntimeMinutes ? "  - 最大分钟: " + ctx.maxRuntimeMinutes : undefined,
  ].filter(Boolean).join("\n"));
  return parts.join("\n\n");
}

export async function evaluateGoal(
  ctx: EvaluationContext,
  agentId = "default",
): Promise<GoalEvaluation | null> {
  const service = resolveModelService(agentId) ?? firstModelService();
  if (!service) return null;
  const userPrompt = buildUserPrompt(ctx);
  try {
    const result = await callLlm(service, {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      temperature: 0.2,
      maxTokens: 1024,
      jsonMode: true,
    });
    return parseGoalEvaluation(result);
  } catch (error) {
    console.error("目标检测失败:", error);
    return null;
  }
}

export function parseGoalEvaluation(raw: string): GoalEvaluation | null {
  const text = raw.trim();
  if (!text) return null;
  const unwrapped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(unwrapped) as Record<string, unknown>;
    if (typeof parsed.complete !== "boolean") return null;
    return normalizeEval(parsed);
  } catch {
    const match = unwrapped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        if (typeof parsed.complete === "boolean") return normalizeEval(parsed);
      } catch (error) { console.debug("目标评估截断失败", error); }
    }
    return null;
  }
}

function normalizeEval(parsed: Record<string, unknown>): GoalEvaluation {
  const complete = parsed.complete as boolean;
  const needsUserInput = typeof parsed.needsUserInput === "boolean" ? parsed.needsUserInput : false;
  const decision = normalizeDecision(parsed.decision, complete, needsUserInput);
  const continuePrompt = typeof parsed.continuePrompt === "string" ? parsed.continuePrompt.trim() : "";
  return {
    complete,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.5,
    decision,
    progressSummary: typeof parsed.progressSummary === "string" ? parsed.progressSummary : "",
    missingItems: Array.isArray(parsed.missingItems) ? parsed.missingItems.filter((i): i is string => typeof i === "string") : [],
    evidence: Array.isArray(parsed.evidence) ? parsed.evidence.filter((i): i is string => typeof i === "string") : [],
    continuePrompt,
    needsUserInput,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    riskLevel: normalizeRiskLevel(parsed.riskLevel),
  };
}

function normalizeDecision(
  value: unknown,
  complete: boolean,
  needsUserInput: boolean,
): GoalEvaluation["decision"] {
  if (
    value === "complete" ||
    value === "continue" ||
    value === "needs_user_input" ||
    value === "blocked" ||
    value === "budget_exhausted"
  ) {
    return value;
  }
  if (complete) return "complete";
  if (needsUserInput) return "needs_user_input";
  return "continue";
}

function normalizeRiskLevel(value: unknown): GoalEvaluation["riskLevel"] {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}
