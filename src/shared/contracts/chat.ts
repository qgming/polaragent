import type { ApprovalDecision, ApprovalRequest } from "./approval";
import type { ChatMessage, ChatPart } from "./session";

/** 待发送队列项：steer 立即插入当前轮次，followUp 在当前轮结束后发送 */
export interface QueuedMessage {
  id: string;
  text: string;
  mode: "steer" | "followUp";
}

/** 发送时的额外控制：重新生成与编辑都要先把 lane 回退到某个条目 */
export interface ChatSendOptions {
  /**
   * 回退到该条目再运行；`null` 表示回退到会话开头（编辑首条用户消息时用）。
   * 不传则是一次普通发送。
   */
  rewindToEntryId?: string | null;
  /**
   * 回退后是否沿用已存在的那条用户消息。
   * - `true`（重新生成）：回退到用户消息本身，用空 prompt 驱动，避免再写一条重复的用户条目。
   * - `false`／不传（编辑、普通发送）：`text` 作为用户消息发出。
   */
  reuseUserMessage?: boolean;
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
  | { type: "compaction-started" }
  | { type: "compaction-ended"; summaryPreview: string }
  | { type: "run-ended"; runId: string; reason: string };
