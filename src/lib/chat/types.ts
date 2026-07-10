import type { ToolPermissionMode } from "@/types/permissions";

export type ChatRole = "assistant" | "user";

export type ChatMessageStatus = "complete" | "streaming" | "error";

export interface ChatAttachment {
  path: string;
  name: string;
  kind: "text" | "image" | "audio" | "document";
  duration?: number;
}

export interface ChatSkillRef {
  id: string;
  name: string;
}

/**
 * Segment 基础接口
 * 所有消息片段的共同属性
 */
interface SegmentBase {
  kind: string;
  /** 创建时间戳（可选，用于记录片段生成时间） */
  createdAt?: number;
}

/**
 * 消息片段类型
 * 支持文本、思考、引导、工具调用等多种类型
 */
export type Segment =
  | (SegmentBase & { kind: "text"; text: string })
  | (SegmentBase & { kind: "thinking"; text: string })
  | (SegmentBase & { kind: "guidance"; text: string })
  | (SegmentBase & {
      kind: "widget";
      widgetId: string;
      title: string;
      html: string;
      updateMode: "replace" | "patch";
      widgetPath?: string | null;
      data?: Record<string, unknown> | null;
    })
  | (SegmentBase & {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      label: string;
      status: "running" | "done" | "error";
      resultText?: string;
      todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
      details?: Record<string, unknown>;
    });

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
  model?: string;
  tokenCount?: number;
  // 输入 token 数（累加所有轮次）
  inputTokens?: number;
  // 输出 token 数（累加所有轮次）
  outputTokens?: number;
  // 缓存写入 token 数（累加所有轮次）
  cacheWriteTokens?: number;
  // 缓存读取 token 数（累加所有轮次）
  cacheReadTokens?: number;
  // 当前上下文 token 数（官方口径：最后一轮 usage 的 totalTokens || 四字段和）
  contextTokens?: number;
  attachments?: ChatAttachment[];
  skillRefs?: ChatSkillRef[];
  segments?: Segment[];
  // Provider 缓存命中标记（0.80 after_provider_response 事件提取）
  providerCacheHit?: boolean;
  // 错误信息（不影响 content 显示）
  error?: string;
  // 当前重试次数（0 = 未重试，1-5 = 正在重试）
  retryAttempt?: number;
}

/**
 * 助手消息完成时由完成回调传入的用量元数据。
 * 普通聊天（chat-store / ChatPage / HomePage / goal-supervisor）共用；
 * 新增字段必须在此统一添加，
 * 避免各调用点的内联类型漂移导致字段被静默丢弃。
 */
export interface MessageFinishMetadata {
  model?: string;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  segments?: Segment[];
}

export interface ChatThread {
  id: string;
  title: string;
  subtitle: string;
  messages: ChatMessage[];
  updatedAt: number;
  agentId?: string;
  permissionMode: ToolPermissionMode;
  knowledgeBaseIds?: string[]; // 当前会话选中的知识库 ID 列表
  loaded?: boolean;
  // 归属的项目 ID（空=普通对话，不属于任何项目）
  projectId?: string;
  autoTitled?: boolean;
}
