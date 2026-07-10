// 目标监督器
// src/ai/goal-supervisor.ts
//
// 包住 promptAgent 的目标自动续跑层：每轮 Agent 输出后由独立评估器判断
// complete / continue / needs_user_input / blocked / budget_exhausted。

import { promptAgent, type AgentResult } from "./agent";
import { evaluateGoal } from "./goal-evaluator";
import { useGoalStore } from "@/stores/goal-store";
import { useChatStore } from "@/stores/chat-store";
import { useTaskMonitorStore } from "@/stores/task-monitor-store";
import { appendGoalEvent } from "@/lib/session/goal";
import {
  DEFAULT_GOAL_MAX_CONSECUTIVE_ERRORS,
  type GoalEvent,
  type GoalEvaluation,
  type GoalState,
  type GoalStatus,
} from "@/lib/goal/types";
import type { ChatAttachment, ChatSkillRef } from "@/lib/chat";
import type { ToolPermissionMode } from "@/types/permissions";

const RETRY_DELAY_MS = 3000;

const createId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `goal-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface GoalExchangeParams {
  threadId: string;
  agentId: string;
  userInput: string;
  projectId?: string;
  workingDir?: string;
  attachments?: ChatAttachment[];
  permissionMode?: ToolPermissionMode;
  knowledgeBaseIds?: string[];
  skillIds?: string[];
  skillRefs?: ChatSkillRef[];
  filePaths?: string[];
}

// 向指定 threadId 追加一条用户消息（不依赖 activeThreadId）。
function addUserMessage(
  threadId: string,
  content: string,
  attachments?: ChatAttachment[],
  skillRefs?: ChatSkillRef[],
): string {
  const id = createId();
  const msg = {
    id,
    role: "user" as const,
    content,
    createdAt: Date.now(),
    status: "complete" as const,
    attachments,
    skillRefs,
  };
  useChatStore.setState((state) => ({
    threads: state.threads.map((t) =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, msg], updatedAt: Date.now() }
        : t,
    ),
  }));
  return id;
}

// 向指定 threadId 追加一条 assistant 占位消息 + 标记运行中。
function addAssistantPlaceholder(threadId: string): string {
  const id = createId();
  const msg = {
    id,
    role: "assistant" as const,
    content: "",
    createdAt: Date.now(),
    status: "streaming" as const,
  };
  useChatStore.setState((state) => ({
    runningThreadIds: state.runningThreadIds.includes(threadId)
      ? state.runningThreadIds
      : [...state.runningThreadIds, threadId],
    threads: state.threads.map((t) =>
      t.id === threadId
        ? { ...t, messages: [...t.messages, msg], updatedAt: Date.now() }
        : t,
    ),
  }));
  return id;
}

function finalizeAssistant(
  threadId: string,
  assistantId: string,
  result: AgentResult,
): void {
  useChatStore.getState().finishAssistant(threadId, assistantId, result.content, {
    model: result.model,
    tokenCount: result.usage.totalTokens,
    inputTokens: result.usage.input,
    outputTokens: result.usage.output,
    cacheReadTokens: result.usage.cacheRead,
    cacheWriteTokens: result.usage.cacheWrite,
    contextTokens: result.contextTokens,
    segments: result.segments,
  });
}

function failAssistantMsg(
  threadId: string,
  assistantId: string,
  error: string,
): void {
  useChatStore.getState().failAssistant(threadId, assistantId, error);
}

async function runSingleRound(
  params: GoalExchangeParams,
  prompt: string,
  attachments?: ChatAttachment[],
): Promise<{ result: AgentResult | null; error: string | null }> {
  addUserMessage(params.threadId, prompt, attachments, params.skillRefs);
  const assistantId = addAssistantPlaceholder(params.threadId);

  return new Promise((resolve) => {
    void promptAgent(
      prompt,
      {
        onStreamUpdate: (update) =>
          useChatStore
            .getState()
            .applyStreamingUpdate(params.threadId, assistantId, update),
        onDone: (result) => {
          finalizeAssistant(params.threadId, assistantId, result);
          resolve({ result, error: null });
        },
        onError: (message) => {
          failAssistantMsg(params.threadId, assistantId, message);
          resolve({ result: null, error: message });
        },
      },
      params.agentId,
      {
        threadId: params.threadId,
        workingDir: params.workingDir,
        messageId: assistantId,
        skillIds: params.skillIds,
        filePaths: params.filePaths,
        attachments,
        permissionMode: params.permissionMode,
        knowledgeBaseIds: params.knowledgeBaseIds,
        projectId: params.projectId,
      },
    );
  });
}

function appendEvent(threadId: string, event: Omit<GoalEvent, "timestamp">): void {
  void appendGoalEvent(threadId, {
    ...event,
    timestamp: Date.now(),
  });
}

function threadTokenTotal(threadId: string): number {
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
  return (
    thread?.messages.reduce((sum, message) => sum + (message.tokenCount ?? 0), 0) ??
    0
  );
}

function goalTokenSpend(threadId: string, goal: GoalState): number {
  return Math.max(0, threadTokenTotal(threadId) - (goal.tokenBaseline ?? 0));
}

function runtimeMinutes(goal: GoalState): number {
  const startedAt = goal.startedAt ?? goal.createdAt;
  const endedAt = goal.completedAt ?? Date.now();
  return Math.max(0, (endedAt - startedAt) / 60000);
}

function budgetExhaustedReason(threadId: string, goal: GoalState): string | null {
  if (goal.maxTurns && goal.evaluatedTurnCount >= goal.maxTurns) {
    return `已达到最大评估轮数 ${goal.maxTurns}`;
  }
  if (goal.maxTokens && goalTokenSpend(threadId, goal) >= goal.maxTokens) {
    return `已达到最大 token 预算 ${goal.maxTokens}`;
  }
  if (goal.maxRuntimeMinutes && runtimeMinutes(goal) >= goal.maxRuntimeMinutes) {
    return `已达到最长运行时间 ${goal.maxRuntimeMinutes} 分钟`;
  }
  return null;
}

function isRunningStatus(status: GoalStatus): boolean {
  return status === "running" || status === "evaluating" || status === "continuing";
}

function isManualRunnableStatus(status: GoalStatus): boolean {
  return (
    status === "ready" ||
    status === "paused" ||
    status === "errored" ||
    status === "needs_user_input" ||
    status === "blocked" ||
    status === "budget_exhausted"
  );
}

function markGoalRunning(
  params: GoalExchangeParams,
  eventType?: "goal_started" | "goal_resumed",
): void {
  const goal = useGoalStore.getState().getGoal(params.threadId);
  if (!goal) return;

  const tokenBaseline = goal.tokenBaseline ?? threadTokenTotal(params.threadId);
  const type = eventType ?? (goal.startedAt ? "goal_resumed" : "goal_started");
  useGoalStore.getState().markStarted(params.threadId, tokenBaseline);
  useGoalStore.getState().setStatus(params.threadId, "running");
  appendEvent(params.threadId, {
    type,
    status: "running",
    autoContinueCount: goal.autoContinueCount,
    evaluatedTurnCount: goal.evaluatedTurnCount,
    tokenBaseline,
  });
}

function setGoalPaused(
  threadId: string,
  error: string,
  evaluation?: GoalEvaluation,
): void {
  useGoalStore.getState().setStatus(threadId, "paused");
  useGoalStore.getState().setError(threadId, error);
  appendEvent(threadId, {
    type: "goal_paused",
    status: "paused",
    evaluation,
    error,
  });
}

function setGoalErrored(threadId: string, error: string): void {
  useGoalStore.getState().setStatus(threadId, "errored");
  useGoalStore.getState().setError(threadId, error);
  appendEvent(threadId, {
    type: "goal_error",
    status: "errored",
    error,
  });
}

function setBudgetExhausted(
  threadId: string,
  reason: string,
  evaluation?: GoalEvaluation,
): void {
  useGoalStore.getState().setStatus(threadId, "budget_exhausted");
  useGoalStore.getState().setError(threadId, reason);
  appendEvent(threadId, {
    type: "goal_budget_exhausted",
    status: "budget_exhausted",
    evaluation,
    error: reason,
  });
}

function setNeedsUserInput(threadId: string, evaluation: GoalEvaluation): void {
  const reason = evaluation.reason || "需要用户补充信息";
  useGoalStore.getState().setStatus(threadId, "needs_user_input");
  useGoalStore.getState().setError(threadId, reason);
  appendEvent(threadId, {
    type: "goal_needs_user_input",
    status: "needs_user_input",
    evaluation,
    error: reason,
  });
}

function setBlocked(threadId: string, evaluation: GoalEvaluation): void {
  const reason = evaluation.reason || "目标执行遇到阻塞";
  useGoalStore.getState().setStatus(threadId, "blocked");
  useGoalStore.getState().setError(threadId, reason);
  appendEvent(threadId, {
    type: "goal_blocked",
    status: "blocked",
    evaluation,
    error: reason,
  });
}

function setCompleted(threadId: string, evaluation: GoalEvaluation): void {
  const completedAt = Date.now();
  useGoalStore.getState().markCompleted(threadId, completedAt);
  appendEvent(threadId, {
    type: "goal_completed",
    status: "completed",
    evaluation,
    completedAt,
  });
}

function recordContinuation(threadId: string, continuePrompt: string): void {
  const before = useGoalStore.getState().getGoal(threadId);
  if (!before) return;

  useGoalStore.getState().incrementContinueCount(threadId);
  const afterIncrement = useGoalStore.getState().getGoal(threadId);
  useGoalStore.getState().setStatus(threadId, "continuing");
  appendEvent(threadId, {
    type: "goal_continued",
    status: "continuing",
    continuePrompt,
    autoContinueCount:
      afterIncrement?.autoContinueCount ?? before.autoContinueCount + 1,
    evaluatedTurnCount:
      afterIncrement?.evaluatedTurnCount ?? before.evaluatedTurnCount,
  });
  useGoalStore.getState().setStatus(threadId, "running");
}

function latestAssistantContent(threadId: string): string | null {
  const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
  const lastAssistant = [...(thread?.messages ?? [])]
    .reverse()
    .find((m) => m.role === "assistant" && m.status === "complete");
  return lastAssistant?.content ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function handleRoundFailure(
  params: GoalExchangeParams,
  error: string | null,
): Promise<boolean> {
  const before = useGoalStore.getState().getGoal(params.threadId);
  if (!before) return false;

  const errorCount = before.consecutiveErrorCount + 1;
  useGoalStore.getState().incrementErrorCount(params.threadId);

  if (errorCount >= DEFAULT_GOAL_MAX_CONSECUTIVE_ERRORS) {
    setGoalErrored(
      params.threadId,
      `连续 ${errorCount} 次错误，已停止: ${error || "请求失败"}`,
    );
    return false;
  }

  const message = `临时错误 (${errorCount}/${DEFAULT_GOAL_MAX_CONSECUTIVE_ERRORS}): ${error || "请求失败"}`;
  useGoalStore.getState().setStatus(params.threadId, "paused");
  useGoalStore.getState().setError(params.threadId, message);
  appendEvent(params.threadId, {
    type: "goal_paused",
    status: "paused",
    error: message,
  });

  await delay(RETRY_DELAY_MS);

  const current = useGoalStore.getState().getGoal(params.threadId);
  if (
    !current ||
    current.status !== "paused" ||
    current.consecutiveErrorCount !== errorCount
  ) {
    return false;
  }

  useGoalStore.getState().setStatus(params.threadId, "running");
  appendEvent(params.threadId, {
    type: "goal_resumed",
    status: "running",
    error: message,
    autoContinueCount: current.autoContinueCount,
    evaluatedTurnCount: current.evaluatedTurnCount,
  });
  return true;
}

async function runRoundWithRetry(
  params: GoalExchangeParams,
  prompt: string,
  attachments?: ChatAttachment[],
): Promise<boolean> {
  let roundAttachments = attachments;

  while (true) {
    const current = useGoalStore.getState().getGoal(params.threadId);
    if (!current || current.status !== "running") return false;

    const { result, error } = await runSingleRound(params, prompt, roundAttachments);
    roundAttachments = undefined;

    const afterRound = useGoalStore.getState().getGoal(params.threadId);
    if (!afterRound || afterRound.status !== "running") return false;

    if (result) {
      useGoalStore.getState().resetErrorCount(params.threadId);
      return true;
    }

    const shouldRetry = await handleRoundFailure(params, error);
    if (!shouldRetry) return false;
  }
}

async function evaluateLatestAssistant(
  params: GoalExchangeParams,
): Promise<string | null> {
  const goal = useGoalStore.getState().getGoal(params.threadId);
  if (!goal || goal.status !== "running") return null;

  const content = latestAssistantContent(params.threadId);
  if (content === null) {
    setGoalPaused(params.threadId, "无法获取助手输出");
    return null;
  }

  const monitor = useTaskMonitorStore.getState().getMonitor(params.threadId);
  const tokenSpend = goalTokenSpend(params.threadId, goal);
  const elapsedMinutes = runtimeMinutes(goal);

  useGoalStore.getState().setStatus(params.threadId, "evaluating");

  const evaluation = await evaluateGoal(
    {
      goalText: goal.goalText,
      successCriteria: goal.successCriteria,
      constraints: goal.constraints,
      lastAssistantContent: content,
      todos: monitor.todos.map((t) => ({ content: t.content, status: t.status })),
      artifacts: monitor.artifacts.map((a) => ({ name: a.name, kind: a.kind })),
      autoContinueCount: goal.autoContinueCount,
      evaluatedTurnCount: goal.evaluatedTurnCount,
      maxTurns: goal.maxTurns,
      maxTokens: goal.maxTokens,
      tokenSpend,
      maxRuntimeMinutes: goal.maxRuntimeMinutes,
      runtimeMinutes: elapsedMinutes,
    },
    params.agentId,
  );

  if (!evaluation) {
    setGoalPaused(params.threadId, "目标检测失败");
    return null;
  }

  useGoalStore.getState().setEvaluation(params.threadId, evaluation);
  useGoalStore.getState().incrementEvaluatedTurnCount(params.threadId);
  const afterEvaluation = useGoalStore.getState().getGoal(params.threadId);
  appendEvent(params.threadId, {
    type: "goal_evaluated",
    status: "evaluating",
    evaluation,
    autoContinueCount:
      afterEvaluation?.autoContinueCount ?? goal.autoContinueCount,
    evaluatedTurnCount:
      afterEvaluation?.evaluatedTurnCount ?? goal.evaluatedTurnCount + 1,
  });

  if (evaluation.complete || evaluation.decision === "complete") {
    setCompleted(params.threadId, evaluation);
    return null;
  }

  if (
    evaluation.needsUserInput ||
    evaluation.decision === "needs_user_input"
  ) {
    setNeedsUserInput(params.threadId, evaluation);
    return null;
  }

  if (evaluation.decision === "blocked") {
    setBlocked(params.threadId, evaluation);
    return null;
  }

  if (evaluation.decision === "budget_exhausted") {
    setBudgetExhausted(
      params.threadId,
      evaluation.reason || "目标评估器判断预算已耗尽",
      evaluation,
    );
    return null;
  }

  const latest = useGoalStore.getState().getGoal(params.threadId);
  if (!latest) return null;
  const budgetReason = budgetExhaustedReason(params.threadId, latest);
  if (budgetReason) {
    setBudgetExhausted(params.threadId, budgetReason, evaluation);
    return null;
  }

  if (!evaluation.continuePrompt.trim()) {
    setGoalPaused(params.threadId, "无法生成续跑提示", evaluation);
    return null;
  }

  return evaluation.continuePrompt.trim();
}

async function driveGoal(
  params: GoalExchangeParams,
  initialPrompt: string,
  initialAttachments?: ChatAttachment[],
  transition?: "goal_started" | "goal_resumed",
): Promise<void> {
  if (transition) {
    markGoalRunning(params, transition);
  }

  let prompt = initialPrompt;
  let attachments = initialAttachments;

  while (true) {
    const goal = useGoalStore.getState().getGoal(params.threadId);
    if (!goal || goal.status !== "running") return;

    const budgetReason = budgetExhaustedReason(params.threadId, goal);
    if (budgetReason) {
      setBudgetExhausted(params.threadId, budgetReason);
      return;
    }

    const completedRound = await runRoundWithRetry(params, prompt, attachments);
    attachments = undefined;
    if (!completedRound) return;

    const continuePrompt = await evaluateLatestAssistant(params);
    if (!continuePrompt) return;

    recordContinuation(params.threadId, continuePrompt);
    prompt = continuePrompt;
  }
}

/**
 * 目标模式下的完整交换流程。
 * 由 ChatPage.handleSend 在目标模式激活且状态可运行时调用。
 */
export async function runGoalExchange(params: GoalExchangeParams): Promise<void> {
  const goal = useGoalStore.getState().getGoal(params.threadId);
  if (!goal || !isManualRunnableStatus(goal.status)) return;

  const transition = goal.startedAt ? "goal_resumed" : "goal_started";
  await driveGoal(params, params.userInput, params.attachments, transition);
}

/**
 * 手动启动目标：从 ready 状态直接启动，使用目标文本作为初始 prompt。
 */
export async function startGoal(
  threadId: string,
  agentId: string,
  projectId?: string,
  workingDir?: string,
  permissionMode?: ToolPermissionMode,
  knowledgeBaseIds?: string[],
): Promise<void> {
  const goal = useGoalStore.getState().getGoal(threadId);
  if (!goal || goal.status !== "ready") return;

  await runGoalExchange({
    threadId,
    agentId,
    userInput: goal.goalText,
    projectId,
    workingDir,
    permissionMode,
    knowledgeBaseIds,
  });
}

/**
 * 手动恢复目标：优先复用最近的续跑 prompt；没有时重新评估最近输出。
 */
export async function resumeGoal(
  threadId: string,
  agentId: string,
  projectId?: string,
  workingDir?: string,
  permissionMode?: ToolPermissionMode,
  knowledgeBaseIds?: string[],
): Promise<void> {
  const goal = useGoalStore.getState().getGoal(threadId);
  if (!goal || !isManualRunnableStatus(goal.status)) return;

  const params: GoalExchangeParams = {
    threadId,
    agentId,
    userInput: goal.lastContinuePrompt || goal.goalText,
    projectId,
    workingDir,
    permissionMode,
    knowledgeBaseIds,
  };

  if (goal.status === "ready") {
    await driveGoal(params, goal.goalText, undefined, "goal_started");
    return;
  }

  markGoalRunning(params, "goal_resumed");

  const refreshed = useGoalStore.getState().getGoal(threadId);
  if (!refreshed) return;

  if (refreshed.lastContinuePrompt) {
    await driveGoal(params, refreshed.lastContinuePrompt, undefined);
    return;
  }

  const continuePrompt = await evaluateLatestAssistant(params);
  if (!continuePrompt) return;

  recordContinuation(threadId, continuePrompt);
  await driveGoal(params, continuePrompt);
}

export function isGoalRunningStatus(status: GoalStatus): boolean {
  return isRunningStatus(status);
}

export function isGoalManualRunnableStatus(status: GoalStatus): boolean {
  return isManualRunnableStatus(status);
}
