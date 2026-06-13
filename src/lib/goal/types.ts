// 目标模式核心类型
// src/lib/goal/types.ts

/** 目标状态机 */
export type GoalStatus =
  | "ready" // 目标已设置，等待首轮发送
  | "running" // Agent 执行中
  | "evaluating" // 目标检测中
  | "continuing" // 生成续跑 prompt，准备下一轮
  | "completed" // 目标完成
  | "paused" // 用户手动暂停
  | "needs_user_input" // 需要用户补充信息
  | "blocked" // 连续遇到同一类阻塞
  | "budget_exhausted" // 达到轮数 / 时间 / token 预算
  | "errored"; // API/网络错误

export type GoalEvaluationDecision =
  | "complete"
  | "continue"
  | "needs_user_input"
  | "blocked"
  | "budget_exhausted";

export type GoalRiskLevel = "low" | "medium" | "high";

/** 单次目标检测结果 */
export interface GoalEvaluation {
  complete: boolean;
  confidence: number;
  decision: GoalEvaluationDecision;
  progressSummary: string;
  missingItems: string[];
  evidence: string[];
  continuePrompt: string;
  needsUserInput: boolean;
  reason: string;
  riskLevel: GoalRiskLevel;
}

/** 目标配置（用户设置后不变） */
export interface GoalConfig {
  /** 目标描述 */
  goalText: string;
  /** 完成标准（可选，更具体的验收条件） */
  successCriteria?: string;
  /** 执行约束（不可变更范围、安全边界、偏好等） */
  constraints?: string;
  /** 最多评估多少轮。默认由 store 设置，避免无限续跑。 */
  maxTurns?: number;
  /** 最多消耗多少输出/输入汇总 token（按当前会话消息元数据估算）。 */
  maxTokens?: number;
  /** 最长运行多少分钟。 */
  maxRuntimeMinutes?: number;
}

/** 目标运行时状态 */
export interface GoalState extends GoalConfig {
  status: GoalStatus;
  /** 已自动续跑次数（仅用于统计展示） */
  autoContinueCount: number;
  /** 已评估的 Agent 轮数 */
  evaluatedTurnCount: number;
  /** 连续错误次数（用于判断是否应该停止） */
  consecutiveErrorCount: number;
  /** 最近一次检测结果 */
  lastEvaluation?: GoalEvaluation;
  /** 最近一次续跑 prompt（用于崩溃恢复后手动继续） */
  lastContinuePrompt?: string;
  /** 最近一次错误信息 */
  lastError?: string;
  /** 目标创建时间戳 */
  createdAt: number;
  /** 首次进入运行态的时间戳 */
  startedAt?: number;
  /** 目标完成时间戳 */
  completedAt?: number;
  /** 目标开始时的会话 token 基线，用于估算本目标消耗 */
  tokenBaseline?: number;
  /** 最近一次状态变更时间戳 */
  updatedAt: number;
}

/** 目标事件（持久化到 JSONL） */
export interface GoalEvent {
  /** 事件类型 */
  type:
    | "goal_set"
    | "goal_started"
    | "goal_evaluated"
    | "goal_continued"
    | "goal_completed"
    | "goal_paused"
    | "goal_needs_user_input"
    | "goal_blocked"
    | "goal_budget_exhausted"
    | "goal_error"
    | "goal_resumed"
    | "goal_cleared";
  status: GoalStatus;
  timestamp: number;
  continuePrompt?: string;
  evaluation?: GoalEvaluation;
  error?: string;
  autoContinueCount?: number;
  evaluatedTurnCount?: number;
  tokenBaseline?: number;
  completedAt?: number;
}

export const DEFAULT_GOAL_MAX_TURNS = 20;
export const DEFAULT_GOAL_MAX_CONSECUTIVE_ERRORS = 5;
