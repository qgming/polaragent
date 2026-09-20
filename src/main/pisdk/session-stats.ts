/**
 * 会话级统计折叠：纯函数增量维护 turn/step 计数、LLM/工具耗时、TTFT、解码速度。
 *
 * 对标 DSH 的 dsh-session-stats 投影（sessionStatsProjectionDefinition），
 * 从 pi harness 事件流增量折叠；折叠结果按会话落盘（见 runtime 的 persistUsage），
 * 重启后打开旧会话直接读回，不重放事件。
 *
 * 因 pi 的 HarnessEvent 不带统一 time 字段，时间由调用方在 handler 中用 Date.now() 传入。
 */

import type { ContextBreakdown, SessionStats } from "@/shared/contracts/session";

/**
 * 启发式 token 估算：按平均 4 字符 / token 折算（DSH 的 estimateMessage 同阶粗估，
 * 用于上下文环的三段分解展示，不是计费依据）。
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

/**
 * 从一份工具清单估算「工具定义」段的 token 数。
 *
 * 每个工具按「name + description + JSON schema 序列化长度」折算；
 * 序列化结果的字符数与模型实际看到的结构化工具定义同阶，
 * 足以让「工具定义」在上下文环里呈现合理的相对占比。
 */
export function estimateToolsTokens(
  tools: readonly { name: string; description?: string; parameters?: unknown }[],
): number {
  if (tools.length === 0) return 0;
  let total = 0;
  for (const tool of tools) {
    const schema = tool.parameters === undefined ? "" : safeStableStringify(tool.parameters);
    total += estimateTokens(`${tool.name}\n${tool.description ?? ""}\n${schema}`);
  }
  return total;
}

/** 不抛错的 JSON 序列化（参数 schema 可能带循环引用/函数） */
function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/**
 * 折叠内部状态：在视图基础上增加 in-flight 边界。
 */
export interface SessionStatsState extends SessionStats {
  /** 当前打开的 step（一次 message_start → message_end 为一步） */
  openStep: {
    messageId: string;
    startTime: number;
    firstTokenTime: number | null;
  } | null;
  /** 上一个 turn 的 turnId，用于去重计数 */
  lastTurnId: string | null;
  /** 正在等 tool_end 的调用, keyed by toolCallId */
  pendingCalls: Record<string, number>;
}

/** 初始值 */
export function initSessionStatsState(): SessionStatsState {
  return {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    openStep: null,
    lastTurnId: null,
    pendingCalls: {},
  };
}

/** 从状态提取视图 */
export function sessionStatsView(state: SessionStatsState): SessionStats {
  return {
    turns: state.turns,
    steps: state.steps,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    ttftMs: state.ttftMs,
    ttftSteps: state.ttftSteps,
    decodeMs: state.decodeMs,
    decodeTokens: state.decodeTokens,
  };
}

// ---- 纯增量事件处理 ----

/** assistant 消息开始计时 */
export function onMessageStart(
  state: SessionStatsState,
  messageId: string,
  now: number,
): SessionStatsState {
  // 防御：前一个 step 未正常关闭就跳过旧 step、打开新的
  return {
    ...state,
    openStep: { messageId, startTime: now, firstTokenTime: null },
  };
}

/**
 * assistant 消息的第一个 delta 到达，记录 firstTokenTime。
 *
 * 只有「当前打开的 step 是这条消息、且还没记过」才写入；其余情况原样返回，
 * 因此可以每个 delta 都无脑调用。
 */
export function onFirstToken(
  state: SessionStatsState,
  messageId: string,
  now: number,
): SessionStatsState {
  const openStep = state.openStep;
  if (openStep === null) return state;
  if (openStep.messageId !== messageId) return state;
  if (openStep.firstTokenTime !== null) return state;
  return {
    ...state,
    openStep: { ...openStep, firstTokenTime: now },
  };
}

/** assistant 消息结束，折叠 llmMs/ttftMs/decodeMs/decodeTokens/steps */
export function onMessageEnd(
  state: SessionStatsState,
  messageId: string,
  now: number,
  outputTokens: number,
): SessionStatsState {
  const openStep = state.openStep;
  if (openStep === null || openStep.messageId !== messageId) return state;

  const llmMs = Math.max(0, now - openStep.startTime);
  const next: SessionStatsState = {
    ...state,
    steps: state.steps + 1,
    llmMs: state.llmMs + llmMs,
    openStep: null,
  };

  const firstTokenTime = openStep.firstTokenTime;
  if (firstTokenTime !== null) {
    const ttft = Math.max(0, firstTokenTime - openStep.startTime);
    next.ttftMs += ttft;
    next.ttftSteps += 1;

    if (outputTokens > 0) {
      next.decodeMs += Math.max(0, now - firstTokenTime);
      next.decodeTokens += outputTokens;
    }
  }

  return next;
}

/** turn 开始。同 turnId 只计一次轮次（对应 DSH step/end 的 turn 判重） */
export function onTurnStart(state: SessionStatsState, turnId: string): SessionStatsState {
  if (state.lastTurnId === turnId) return state;
  return {
    ...state,
    turns: state.turns + 1,
    lastTurnId: turnId,
  };
}

/** tool 调用开始 */
export function onToolStart(
  state: SessionStatsState,
  toolCallId: string,
  now: number,
): SessionStatsState {
  if (Object.hasOwn(state.pendingCalls, toolCallId)) {
    return state;
  }
  return {
    ...state,
    pendingCalls: {
      ...state.pendingCalls,
      [toolCallId]: now,
    },
  };
}

/** tool 调用结束 */
export function onToolEnd(
  state: SessionStatsState,
  toolCallId: string,
  now: number,
): SessionStatsState {
  const dispatched = state.pendingCalls[toolCallId];
  if (dispatched === undefined) return state;

  const toolMs = Math.max(0, now - dispatched);
  const pendingCalls = { ...state.pendingCalls };
  delete pendingCalls[toolCallId];

  return {
    ...state,
    toolMs: state.toolMs + toolMs,
    pendingCalls,
  };
}

/** run 结束，清理 pending calls */
export function onRunEnd(state: SessionStatsState): SessionStatsState {
  const hasPending = Object.keys(state.pendingCalls).length > 0;
  return {
    ...state,
    ...(hasPending ? { pendingCalls: {} } : {}),
  };
}

// ---- 上下文分解 ----

/**
 * 从一次请求的 usage 样本推导三段分解。
 *
 * 系统提示词与工具定义是**估算值**（构建请求时按字符数折算），
 * 对话消息按「压力总量 − 系统 − 工具」倒推，不足时钳到 0。
 * 压力按提示侧计费口径：未缓存输入 + 缓存读取 + 缓存写入（与 DSH
 * token-meter 的 pressureFrom 一致）。
 */
export function deriveContextBreakdown(
  breakdown: Omit<ContextBreakdown, "messageTokens">,
  usage: { inputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number },
): ContextBreakdown {
  const pressure = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return {
    systemTokens: breakdown.systemTokens,
    toolsTokens: breakdown.toolsTokens,
    messageTokens: Math.max(0, pressure - breakdown.systemTokens - breakdown.toolsTokens),
  };
}
