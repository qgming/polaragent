import type { JsonValue } from "@earendil-works/chord";
import type { Op } from "@earendil-works/chord/delta";
import type { ApprovalDecision, ApprovalRequest } from "./approval";
import type { AskOutcome, AskRequest } from "./interaction";
import type { JobInfo } from "./job";
import type { ChatMessage, ContextBreakdown, SessionStats, SessionTokenUsage } from "./session";

/** followUp 等本轮结束；steer 在会话中立即显示，由内核在下一执行边界接收。 */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: "steer" | "followUp";
}

/** 发送时的额外控制：编辑用户消息要先把 lane 回退到该消息的父条目 */
export interface ChatSendOptions {
  /**
   * 回退到该条目再运行；`null` 表示回退到会话开头。不传则是一次普通发送。
   * 回退后必须随之追加一条消息（`text`）—— pi 拒收空 prompt，见 runtime 的 send。
   */
  rewindToEntryId?: string | null;
}

/** Immutable desktop projection of a committed native conversation view. */
export interface ChatToolReport {
  text: string;
  isError: boolean;
  details: JsonValue;
}

/** One model request's automatic retries; attempt counts retries, excluding the first request. */
export interface ChatRetryState {
  generationId: string;
  phase: "retrying" | "failed";
  /** 1..maxAttempts while retrying; 0 for a failure that cannot be retried. */
  attempt: number;
  maxAttempts: number;
  error: string;
}

export interface ChatLiveState {
  workflow?: import("./workflow").WorkflowState;
  conversationId: number;
  messages: ChatMessage[];
  reports: Record<string, ChatToolReport>;
  admittedRequestIds: string[];
  running: boolean;
  runId: string | null;
  queue: QueuedMessage[];
  usage: SessionTokenUsage;
  compaction: SessionCompaction | null;
  retry?: ChatRetryState | null;
}

export interface ChatLiveSnapshot {
  generation: number;
  revision: number;
  state: ChatLiveState;
}

/** A new mount always starts with a base; Chord operations apply to one exact prior revision. */
export type ChatViewFrame =
  | ChatLiveSnapshot
  | {
      generation: number;
      revision: number;
      previousRevision: number;
      ops: readonly Op[];
    };

/**
 * 压缩为什么发生。内核的 `compaction_start` / `compaction_end` 都带这个字段：
 * - `manual`：用户敲了 `/compact`；
 * - `threshold`：自动——估算上下文超过 `contextWindow − reserveTokens`；
 * - `overflow`：自动——供应商报了上下文溢出后的兜底（每代限一次）。
 *
 * 界面必须把它显示出来：同样是「压缩中」，用户主动触发的和后台自动发生的，
 * 解释完全不同。
 */
export type CompactionReason = "manual" | "threshold" | "overflow";

/** 压缩的结局。`declined` 是内核主动放弃（例如准备阶段发现没什么可压） */
export type CompactionStatus = "completed" | "declined" | "aborted" | "failed";

/**
 * `/compact` 的失败原因（IPC 用结果对象传递，不用抛异常）。
 *
 * 为什么要有稳定的 code：错误文案要按语言渲染，而主进程抛出的中文 message
 * 在英文界面里是错的语言；渲染层拿到 code 自己查词条，未知 code 再回落到 message。
 */
export type CompactFailureCode =
  /** lane 上压着别的操作（正在跑一轮、或已在压缩） */
  | "busy"
  /** 没有可压缩的历史（对话还很短） */
  | "nothing"
  /** 其他失败：message 里是主进程给出的人话原因 */
  | "failed";

export type CompactOutcome =
  | { ok: true }
  | { ok: false; code: CompactFailureCode; message: string };

/**
 * 渲染层维护的「这个会话最近一次压缩」。
 *
 * 来自原生 live 文档、压缩任务 receipt 与摘要条目的投影。
 * 放在契约里而不是 store 里：store 与压缩条（ThreadToolbar）都要用，两处各写一份形状
 * 迟早会漂移。
 */
export interface SessionCompaction {
  /** 进行中 / 已完成 / 失败 / 已取消（declined 与 aborted 都归到 cancelled） */
  phase: "running" | "completed" | "failed" | "cancelled";
  reason: CompactionReason;
  startedAt: number;
  endedAt?: number;
  /** 完成时的摘要预览（前 200 字） */
  summaryPreview?: string;
  /** 完成时：压缩前估算的上下文 tokens */
  tokensBefore?: number;
  /** 完成时：压缩后保留的近期消息条数 */
  retainedCount?: number;
  /** 失败原因（主进程给的人话） */
  error?: string;
}

/** 主进程 → 渲染进程的聊天事件；渲染进程只消费，不反向发送 */
export type ChatEvent =
  | { type: "view"; frame: ChatViewFrame }
  | { type: "input-admitted"; messageId: string; entryId?: string }
  | { type: "input-cancelled"; messageId: string }
  | { type: "input-failed"; messageId?: string; error: string }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string; decision: ApprovalDecision }
  /** 模型在关键分叉点上提问：渲染层把提问卡挂到消息流尾部，等用户作答 */
  | { type: "ask-requested"; request: AskRequest }
  | { type: "ask-resolved"; id: string; outcome: AskOutcome }
  /** 会话被 AI 自动命名（或改标题）：渲染层据此就地替换侧栏里的默认名 */
  | { type: "session-titled"; sessionId: string; title: string }
  /**
   * AI 预审出结论但不放行：请求仍挂起，等待用户覆盖。
   * 渲染层据此把审批卡从「审批中」切回可操作态，并显示 AI 给的理由。
   */
  | { type: "approval-reviewed"; id: string; reason: string }
  /**
   * 后台作业新建 / 状态变更 / 退出：渲染层据此维护作业列表
   * （服务见 main/pisdk/jobs.ts；退出时的模型通知见 runtime.ts 的作业唤醒预算）。
   */
  | { type: "job-changed"; job: JobInfo }
  /** 作业被淘汰，或随会话关闭 / 进程退出被清理：渲染层把它从列表里删掉 */
  | { type: "job-removed"; id: string }
  /**
   * 会话级统计更新：turn/step 计数与 LLM/工具/TTFT/解码耗时。
   * 渲染层据此刷新输入框下方的状态条与「会话统计」弹层。
   */
  | { type: "session-stats"; stats: SessionStats }
  /**
   * 上下文占用分解更新：系统提示词 / 工具定义 / 对话消息三段的启发式估算。
   * 渲染层据此绘制输入框旁「上下文已用」环的展开面板。
   */
  | { type: "context-breakdown"; breakdown: ContextBreakdown };

/**
 * 主进程 → 渲染进程的推送信封：事件 + 它属于哪个会话。
 *
 * 为什么归属要由主进程给出：主进程里每个会话各有独立的 harness / lane，可以同时在跑；
 * 渲染层不能再拿「当前打开的会话」去猜一条事件属于谁 —— 用户切走之后，后台会话的
 * 流式内容会被记到别的会话头上，侧栏的「运行中」也会跟着错。
 */
export interface ChatEventEnvelope {
  /** 事件所属会话 id */
  sessionId: string;
  event: ChatEvent;
}
