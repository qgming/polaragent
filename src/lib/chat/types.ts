// 对话消息模型 —— 对齐 assistant-ui MessagePart
// src/lib/chat/types.ts
//
// 旧 Segment 模型废弃。消息 content 直接使用 assistant-ui 兼容的 parts，
// ExternalStoreRuntime 几乎零转换开销。

import type { ToolPermissionMode } from "@/types/permissions";

export type ChatRole = "assistant" | "user";

export type ChatMessageStatus =
  | "complete"
  | "running"
  | "incomplete"
  | "error";

export interface ChatAttachment {
  path: string;
  name: string;
  kind: "text" | "image" | "audio" | "document";
  duration?: number;
}

/** 文本片段 */
export interface TextPart {
  type: "text";
  text: string;
}

/** 思考/推理片段 */
export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

/** 工具调用片段（对齐 assistant-ui ToolCallMessagePart） */
export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  argsText: string;
  result?: unknown;
  isError?: boolean;
  /** 展示用中文标签 */
  label?: string;
  /** 附加展示信息 */
  polar?: {
    status: "running" | "complete" | "error";
    resultText?: string;
    details?: Record<string, unknown>;
  };
}

/** 过程引导片段 */
export interface GuidancePart {
  type: "data-polar-guidance";
  data: {
    text: string;
    createdAt?: number;
  };
}

export type ChatMessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallPart
  | GuidancePart;

export interface ChatMessageMetadata {
  model?: string;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  providerCacheHit?: boolean;
  error?: string;
  retryAttempt?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  createdAt: number;
  status: ChatMessageStatus;
  /** assistant-ui 兼容的有序内容 parts */
  content: ChatMessagePart[];
  attachments?: ChatAttachment[];
  metadata?: ChatMessageMetadata;
}

export interface MessageFinishMetadata {
  model?: string;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  content?: ChatMessagePart[];
}

export interface ChatThread {
  id: string;
  title: string;
  subtitle: string;
  messages: ChatMessage[];
  updatedAt: number;
  permissionMode: ToolPermissionMode;
  /** 该会话的工作目录（工具执行根目录） */
  workingDir?: string;
  loaded?: boolean;
  autoTitled?: boolean;
}

/** 从 parts 拼出纯文本（用于标题生成、剪贴板等） */
export function partsToPlainText(parts: ChatMessagePart[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") chunks.push(part.text);
  }
  return chunks.join("\n");
}

/** 是否包含可见正文 */
export function hasVisibleText(parts: ChatMessagePart[]): boolean {
  return parts.some((p) => p.type === "text" && p.text.trim().length > 0);
}
