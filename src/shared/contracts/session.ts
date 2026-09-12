import type { ModelRef } from "./common";

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string;
  parentSessionId?: string;
  archived: boolean;
  /** 置顶：置顶的会话只出现在侧栏「置顶」分组，不再出现在项目/最近分组 */
  pinned: boolean;
  messageCount: number;
  /**
   * 该会话自己指定的模型；null = 跟随设置里的默认模型。
   *
   * 与 cwd 同一个模式：会话级选择优先，没有就回落到全局默认。持久化在会话索引里，
   * 所以重启后仍然生效。
   */
  model: ModelRef | null;
}

/** 切换会话模型失败的原因：界面据此给出具体说明，而不是笼统的「失败」 */
export type SessionModelFailure =
  /** 正在运行：中途换模型会让同一段对话里的工具调用/思考历史跨供应商，先停下再换 */
  | "running"
  /** 目标模型在当前设置里不存在（服务被删、模型被删，或压根没配） */
  | "no-model";

export type SetSessionModelResult = { ok: true } | { ok: false; reason: SessionModelFailure };

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
  /** 工具自己声明的结构化详情（如 edit 的 diff/patch）；形状由工具决定，渲染层按工具名取用 */
  details?: unknown;
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
  /**
   * pi 条目树里的父条目 id。渲染层据此把它交给 assistant-ui 的分支仓库，
   * 同一父条目下的多条助手回复即成为可切换的分支（重新生成会产生这种兄弟关系）。
   */
  parentId?: string | null;
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
