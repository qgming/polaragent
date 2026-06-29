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

export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "guidance"; text: string; createdAt: number }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      label: string;
      status: "running" | "done" | "error";
      resultText?: string;
      todos?: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>;
      details?: Record<string, unknown>;
    };

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  status: ChatMessageStatus;
  model?: string;
  tokenCount?: number;
  attachments?: ChatAttachment[];
  skillRefs?: ChatSkillRef[];
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
  autoTitled?: boolean;
}
