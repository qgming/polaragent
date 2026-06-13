// 目标模式持久化
// src/lib/session/goal.ts
//
// 用 pi Session 的 appendCustomEntry 把目标配置和事件写进 JSONL。
// 回读时取最后一条 goal_config + 最后一条 goal_event 还原 GoalState。

import {
  DEFAULT_GOAL_MAX_TURNS,
  type GoalConfig,
  type GoalEvent,
  type GoalState,
  type GoalStatus,
} from "@/lib/goal/types";
import { GOAL_CONFIG_ENTRY, GOAL_EVENT_ENTRY } from "./entries";
import { openOrCreateSession } from "./lifecycle";

/** 写入目标配置（设置/更新目标时调用一次） */
export async function appendGoalConfig(
  sessionId: string,
  config: GoalConfig,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(GOAL_CONFIG_ENTRY, {
      goalText: config.goalText,
      successCriteria: config.successCriteria ?? "",
      constraints: config.constraints ?? "",
      maxTurns: config.maxTurns,
      maxTokens: config.maxTokens,
      maxRuntimeMinutes: config.maxRuntimeMinutes,
    });
  } catch (error) {
    console.error(`写入目标配置失败 ${sessionId}:`, error);
  }
}

/** 写入目标事件 */
export async function appendGoalEvent(
  sessionId: string,
  event: GoalEvent,
): Promise<void> {
  try {
    const session = await openOrCreateSession(sessionId);
    await session.appendCustomEntry(GOAL_EVENT_ENTRY, event);
  } catch (error) {
    console.error(`写入目标事件失败 ${sessionId}:`, error);
  }
}

/**
 * 从会话 JSONL 回读目标状态（用于崩溃恢复 / 切换会话时回填）。
 * 遍历所有 custom entries，取最后一条 goal_config 和最后一条 goal_event。
 */
export async function readGoalState(
  sessionId: string,
): Promise<GoalState | null> {
  try {
    const session = await openOrCreateSession(sessionId);
    const entries = await session.getEntries();

    return replayGoalStateFromEntries(entries);
  } catch (error) {
    console.error(`回读目标状态失败 ${sessionId}:`, error);
    return null;
  }
}

export function replayGoalStateFromEntries(
  entries: Array<{ type: string; customType?: string; data?: unknown }>,
): GoalState | null {
  let state: GoalState | null = null;
  let cleared = false;

  for (const entry of entries) {
    if (entry.type !== "custom") continue;

    if (entry.customType === GOAL_CONFIG_ENTRY) {
      const config = parseGoalConfig(entry.data);
      if (!config) continue;
      const now = Date.now();
      state = {
        ...config,
        status: "ready",
        autoContinueCount: 0,
        evaluatedTurnCount: 0,
        consecutiveErrorCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      cleared = false;
      continue;
    }

    if (entry.customType !== GOAL_EVENT_ENTRY || !state) continue;
    const event = parseGoalEvent(entry.data);
    if (!event) continue;

    if (event.type === "goal_cleared") {
      cleared = true;
      state = null;
      continue;
    }

    cleared = false;
    const safeStatus = safeRestoredStatus(event.status);
    const nextContinuePrompt: string | undefined =
      event.type === "goal_evaluated"
        ? event.evaluation?.continuePrompt.trim() || undefined
        : typeof event.continuePrompt === "string"
          ? event.continuePrompt || undefined
          : state.lastContinuePrompt;
    const clearsError =
      event.type === "goal_started" ||
      event.type === "goal_resumed" ||
      event.type === "goal_continued" ||
      event.type === "goal_evaluated" ||
      event.type === "goal_completed";

    state = {
      ...state,
      status: safeStatus,
      autoContinueCount: event.autoContinueCount ?? state.autoContinueCount,
      evaluatedTurnCount: event.evaluatedTurnCount ?? state.evaluatedTurnCount,
      consecutiveErrorCount: 0,
      lastEvaluation: event.evaluation ?? state.lastEvaluation,
      lastContinuePrompt: nextContinuePrompt,
      lastError: event.error ?? (clearsError ? undefined : state.lastError),
      startedAt:
        event.type === "goal_started" || event.type === "goal_resumed"
          ? state.startedAt ?? event.timestamp
          : state.startedAt,
      tokenBaseline: event.tokenBaseline ?? state.tokenBaseline,
      completedAt:
        event.type === "goal_completed"
          ? event.completedAt ?? event.timestamp
          : state.completedAt,
      updatedAt: event.timestamp,
    };
  }

  return cleared ? null : state;
}

function parseGoalConfig(data: unknown): GoalConfig | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (typeof record.goalText !== "string" || !record.goalText.trim()) return null;
  return {
    goalText: record.goalText.trim(),
    successCriteria: readTrimmedString(record.successCriteria),
    constraints: readTrimmedString(record.constraints),
    maxTurns: readPositiveInteger(record.maxTurns, DEFAULT_GOAL_MAX_TURNS),
    maxTokens: readPositiveInteger(record.maxTokens),
    maxRuntimeMinutes: readPositiveInteger(record.maxRuntimeMinutes),
  };
}

function parseGoalEvent(data: unknown): GoalEvent | null {
  if (!data || typeof data !== "object") return null;
  const event = data as Partial<GoalEvent>;
  if (typeof event.type !== "string" || typeof event.status !== "string") return null;
  return {
    ...event,
    type: event.type as GoalEvent["type"],
    status: event.status as GoalStatus,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
  };
}

function safeRestoredStatus(status: GoalStatus): GoalStatus {
  if (status === "running" || status === "evaluating" || status === "continuing") {
    return "paused";
  }
  return status;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInteger(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const next = Math.floor(value);
  return next > 0 ? next : fallback;
}
