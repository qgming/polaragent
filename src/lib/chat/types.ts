import type { ToolPermissionMode } from "@/types/permissions";

export type ChatRole = "assistant" | "user";

export type ChatMessageStatus = "complete" | "streaming" | "error";

export interface ChatAttachment {
  path: string;
  name: string;
  kind: "text" | "image" | "audio";
  duration?: number;
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
  loaded?: boolean;
  autoTitled?: boolean;
}
