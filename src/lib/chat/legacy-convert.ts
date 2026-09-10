// 旧 Segment 模型 → ChatMessagePart 一次性转换
// src/lib/chat/legacy-convert.ts
//
// 历史持久化数据可能仍是「string content + Segment[]」旧结构。
// 本模块在回读/水合时做一次转换，转换后统一为 ChatMessagePart[]。

import type {
  ChatMessage,
  ChatMessagePart,
  ChatMessageMetadata,
  ChatMessageStatus,
  ChatAttachment,
  GuidancePart,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "./types";

/** 旧 Segment 形状（仅用于识别历史数据，新代码不要再使用） */
type LegacySegment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      label: string;
      status: "running" | "error" | "done";
      resultText?: string;
      details?: Record<string, unknown>;
    }
  | { kind: "guidance"; text: string; createdAt?: number };

/** 旧 ChatMessage 形状（string content + 可选 segments / 顶层 usage 字段） */
interface LegacyChatMessage {
  id: string;
  role: "user" | "assistant";
  createdAt: number;
  status?: string;
  content: string;
  attachments?: ChatAttachment[];
  segments?: LegacySegment[];
  model?: string;
  tokenCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextTokens?: number;
  error?: string;
  retryAttempt?: number;
}

/** 旧 tool status → 新 tool-call status（done → complete） */
function mapToolStatus(status: string): "running" | "complete" | "error" {
  if (status === "error") return "error";
  if (status === "running") return "running";
  return "complete";
}

function convertLegacySegment(segment: LegacySegment): ChatMessagePart | null {
  switch (segment.kind) {
    case "text": {
      if (!segment.text) return null;
      const part: TextPart = { type: "text", text: segment.text };
      return part;
    }
    case "thinking": {
      if (!segment.text) return null;
      const part: ReasoningPart = { type: "reasoning", text: segment.text };
      return part;
    }
    case "tool": {
      const part: ToolCallPart = {
        type: "tool-call",
        toolCallId: segment.toolCallId,
        toolName: segment.toolName,
        // 旧 Segment 不保存 args，仅回填展示所需字段
        args: {},
        argsText: "",
        result: segment.resultText,
        isError: segment.status === "error",
        label: segment.label,
        polar: {
          status: mapToolStatus(segment.status),
          resultText: segment.resultText,
          details: segment.details,
        },
      };
      return part;
    }
    case "guidance": {
      const part: GuidancePart = {
        type: "data-polar-guidance",
        data: {
          text: segment.text,
          createdAt: segment.createdAt,
        },
      };
      return part;
    }
    default:
      return null;
  }
}

/** 把旧 Segment[] 转为 ChatMessagePart[] */
export function convertLegacySegments(
  segments: LegacySegment[] | undefined,
): ChatMessagePart[] {
  if (!segments || segments.length === 0) return [];
  const parts: ChatMessagePart[] = [];
  for (const segment of segments) {
    const part = convertLegacySegment(segment);
    if (part) parts.push(part);
  }
  return parts;
}

function mapLegacyStatus(status: string | undefined): ChatMessageStatus {
  switch (status) {
    case "streaming":
    case "running":
      return "running";
    case "error":
      return "error";
    case "incomplete":
      return "incomplete";
    default:
      return "complete";
  }
}

function buildLegacyMetadata(legacy: LegacyChatMessage): ChatMessageMetadata | undefined {
  const metadata: ChatMessageMetadata = {
    model: legacy.model,
    tokenCount: legacy.tokenCount,
    inputTokens: legacy.inputTokens,
    outputTokens: legacy.outputTokens,
    cacheReadTokens: legacy.cacheReadTokens,
    cacheWriteTokens: legacy.cacheWriteTokens,
    contextTokens: legacy.contextTokens,
    error: legacy.error,
    retryAttempt: legacy.retryAttempt,
  };
  const hasMetadata = Object.values(metadata).some((v) => v !== undefined);
  return hasMetadata ? metadata : undefined;
}

/**
 * 判断是否为旧格式消息（content 为 string，或带 segments 字段）。
 */
export function isLegacyChatMessage(value: unknown): value is LegacyChatMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.content === "string" || Array.isArray(record.segments);
}

/**
 * 把旧格式 ChatMessage 转为新格式（content: ChatMessagePart[]）。
 * 已是新格式时原样返回。
 */
export function convertLegacyChatMessage(value: unknown): ChatMessage {
  if (!isLegacyChatMessage(value)) {
    return value as ChatMessage;
  }

  const legacy = value;
  const parts: ChatMessagePart[] = [];

  // guidance 段放在正文前（与旧 UI 渲染顺序一致）
  const guidanceParts: ChatMessagePart[] = [];
  const otherParts: ChatMessagePart[] = [];
  for (const segment of legacy.segments ?? []) {
    const part = convertLegacySegment(segment);
    if (!part) continue;
    if (part.type === "data-polar-guidance") {
      guidanceParts.push(part);
    } else {
      otherParts.push(part);
    }
  }
  parts.push(...guidanceParts, ...otherParts);

  // 旧 content 为 string：若 segments 里尚无 text part，则把 string 作为 text part
  const hasTextPart = parts.some((p) => p.type === "text");
  if (typeof legacy.content === "string" && legacy.content.trim() && !hasTextPart) {
    parts.unshift({ type: "text", text: legacy.content });
  }

  return {
    id: legacy.id,
    role: legacy.role,
    createdAt: legacy.createdAt,
    status: mapLegacyStatus(legacy.status),
    content: parts,
    attachments: legacy.attachments,
    metadata: buildLegacyMetadata(legacy),
  };
}

/** 批量转换旧格式消息列表 */
export function convertLegacyChatMessages(values: unknown[]): ChatMessage[] {
  return values.map(convertLegacyChatMessage);
}
