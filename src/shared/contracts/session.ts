export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  parentSessionId?: string;
  archived: boolean;
  messageCount: number;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
}

export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  /** 流式期间可能尚未解析完成，保留原始文本；args 为解析成功后的结果 */
  argsText: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status: "running" | "done" | "error" | "pending-approval" | "denied";
}

export interface ImagePart {
  type: "image";
  mimeType: string;
  dataUrl: string;
}

export type ChatPart = TextPart | ReasoningPart | ToolCallPart | ImagePart;

export interface ChatMessageUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: string;
  /** 关联的会话存储条目 id；本地临时消息可为空 */
  entryId?: string;
  role: "user" | "assistant";
  createdAt: number;
  parts: ChatPart[];
  status: "complete" | "streaming" | "error";
  usage?: ChatMessageUsage;
  error?: string;
}

/** 会话消息分页结果：nextCursor 存在时表示还能继续向上加载更早消息 */
export interface SessionMessagesPage {
  messages: ChatMessage[];
  compactionSummaries: string[];
  nextCursor?: number;
}

export interface LoadSessionMessagesOptions {
  limit?: number;
  beforeSeq?: number;
}
