// 目标模式 Store
// src/stores/goal-store.ts
//
// 按 threadId 管理每个会话的目标状态。
// 目标模式仅用于普通对话，团队模式不使用。

import { create } from "zustand";
import {
  DEFAULT_GOAL_MAX_TURNS,
  type GoalConfig,
  type GoalEvaluation,
  type GoalState,
  type GoalStatus,
} from "@/lib/goal/types";

interface GoalStoreState {
  /** 按 threadId 索引目标状态；无目标的会话不在 map 中 */
  byThread: Record<string, GoalState>;

  /** 读取目标（无目标时返回 undefined） */
  getGoal: (threadId: string) => GoalState | undefined;

  /** 设置目标（新建或更新配置） */
  setGoal: (threadId: string, config: GoalConfig) => void;

  /** 清除目标 */
  clearGoal: (threadId: string) => void;

  /** 更新状态 */
  setStatus: (threadId: string, status: GoalStatus) => void;

  /** 记录检测结果 */
  setEvaluation: (threadId: string, evaluation: GoalEvaluation) => void;

  /** 记录续跑 prompt */
  setContinuePrompt: (threadId: string, prompt: string) => void;

  /** 记录错误 */
  setError: (threadId: string, error: string) => void;

  /** 递增续跑计数 */
  incrementContinueCount: (threadId: string) => void;

  /** 递增已评估轮数 */
  incrementEvaluatedTurnCount: (threadId: string) => void;

  /** 递增连续错误计数 */
  incrementErrorCount: (threadId: string) => void;

  /** 重置连续错误计数 */
  resetErrorCount: (threadId: string) => void;

  /** 标记目标开始运行并记录 token 基线 */
  markStarted: (threadId: string, tokenBaseline?: number) => void;

  /** 标记目标完成并记录完成时间 */
  markCompleted: (threadId: string, completedAt?: number) => void;

  /** 从持久化恢复目标状态（崩溃恢复） */
  hydrateGoal: (threadId: string, state: GoalState) => void;

  /** 目标是否处于可自动续跑状态 */
  canAutoContinue: (threadId: string) => boolean;

  /** 目标是否处于可手动恢复状态 */
  canResume: (threadId: string) => boolean;
}

export const useGoalStore = create<GoalStoreState>((set, get) => ({
  byThread: {},

  getGoal: (threadId) => get().byThread[threadId],

  setGoal: (threadId, config) => {
    const now = Date.now();
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...normalizeConfig(config),
          status: "ready",
          autoContinueCount: 0,
          evaluatedTurnCount: 0,
          consecutiveErrorCount: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
    }));
  },

  clearGoal: (threadId) => {
    set((state) => {
      const next = { ...state.byThread };
      delete next[threadId];
      return { byThread: next };
    });
  },

  setStatus: (threadId, status) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...existing, status, updatedAt: Date.now() },
        },
      };
    });
  },

  setEvaluation: (threadId, evaluation) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            lastEvaluation: evaluation,
            lastContinuePrompt: evaluation.continuePrompt.trim() || undefined,
            lastError: undefined,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  setContinuePrompt: (threadId, prompt) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...existing, lastContinuePrompt: prompt, updatedAt: Date.now() },
        },
      };
    });
  },

  setError: (threadId, error) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...existing, lastError: error, updatedAt: Date.now() },
        },
      };
    });
  },

  incrementContinueCount: (threadId) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            autoContinueCount: existing.autoContinueCount + 1,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  incrementEvaluatedTurnCount: (threadId) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            evaluatedTurnCount: existing.evaluatedTurnCount + 1,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  incrementErrorCount: (threadId) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            consecutiveErrorCount: existing.consecutiveErrorCount + 1,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  resetErrorCount: (threadId) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            consecutiveErrorCount: 0,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  markStarted: (threadId, tokenBaseline) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            startedAt: existing.startedAt ?? Date.now(),
            tokenBaseline: existing.tokenBaseline ?? tokenBaseline,
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  markCompleted: (threadId, completedAt = Date.now()) => {
    set((state) => {
      const existing = state.byThread[threadId];
      if (!existing) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...existing,
            status: "completed",
            completedAt,
            lastError: undefined,
            updatedAt: completedAt,
          },
        },
      };
    });
  },

  hydrateGoal: (threadId, goalState) => {
    set((state) => {
      // 仅在内存中尚无该会话目标时回填，避免覆盖运行期数据
      if (state.byThread[threadId]) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...goalState,
            ...normalizeConfig(goalState),
            evaluatedTurnCount: goalState.evaluatedTurnCount ?? 0,
            createdAt: goalState.createdAt ?? goalState.updatedAt ?? Date.now(),
          },
        },
      };
    });
  },

  canAutoContinue: (threadId) => {
    const goal = get().byThread[threadId];
    if (!goal) return false;
    if (
      goal.status !== "paused" &&
      goal.status !== "errored"
    ) return false;
    if (goal.lastEvaluation?.needsUserInput) return false;
    return Boolean(goal.lastContinuePrompt);
  },

  canResume: (threadId) => {
    const goal = get().byThread[threadId];
    if (!goal) return false;
    return (
      goal.status === "paused" ||
      goal.status === "errored" ||
      goal.status === "ready" ||
      goal.status === "needs_user_input" ||
      goal.status === "blocked" ||
      goal.status === "budget_exhausted"
    );
  },
}));

function normalizeConfig(config: GoalConfig): GoalConfig {
  return {
    goalText: config.goalText.trim(),
    successCriteria: config.successCriteria?.trim() || undefined,
    constraints: config.constraints?.trim() || undefined,
    maxTurns: normalizePositiveInteger(config.maxTurns, DEFAULT_GOAL_MAX_TURNS),
    maxTokens: normalizePositiveInteger(config.maxTokens),
    maxRuntimeMinutes: normalizePositiveInteger(config.maxRuntimeMinutes),
  };
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback?: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  return next > 0 ? next : fallback;
}
