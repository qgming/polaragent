import type { ApprovalDecision, ApprovalRequest } from "./approval";
import type { ChatMessage, ChatPart } from "./session";

/** 待发送队列项：steer 立即插入当前轮次，followUp 在当前轮结束后发送 */
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

/** 主进程 → 渲染进程的聊天事件；渲染进程只消费，不反向发送 */
export type ChatEvent =
  | { type: "run-started"; runId: string }
  | { type: "message-added"; message: ChatMessage }
  | { type: "part-upsert"; messageId: string; partIndex: number; part: ChatPart }
  | {
      type: "message-updated";
      messageId: string;
      patch: Partial<Pick<ChatMessage, "status" | "usage" | "error" | "entryId" | "parentId">>;
    }
  | { type: "queue-updated"; items: QueuedMessage[] }
  | { type: "approval-requested"; request: ApprovalRequest }
  | { type: "approval-resolved"; id: string; decision: ApprovalDecision }
  /** 会话被 AI 自动命名（或改标题）：渲染层据此就地替换侧栏里的默认名 */
  | { type: "session-titled"; sessionId: string; title: string }
  /**
   * AI 预审出结论但不放行：请求仍挂起，等待用户覆盖。
   * 渲染层据此把审批卡从「审批中」切回可操作态，并显示 AI 给的理由。
   */
  | { type: "approval-reviewed"; id: string; reason: string }
  | { type: "compaction-started" }
  | { type: "compaction-ended"; summaryPreview: string }
  | { type: "run-ended"; runId: string; reason: string };
