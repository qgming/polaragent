import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type {
  ChatMessage,
  ChatMessageUsage,
  ChatPart,
  ToolCallPart,
} from "@/shared/contracts/session";

type UserMessage = Extract<AgentMessage, { role: "user" }>;
type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;

/** 记录已映射出的 tool-call part，等待后续 toolResult 条目回填 */
type PendingToolCalls = Map<string, ToolCallPart>;

function toDataUrl(mimeType: string, data: string): string {
  return `data:${mimeType};base64,${data}`;
}

/** 未知块类型只告警不抛错，避免历史数据把整个会话回读打断 */
function warnUnknownBlock(entryId: string, block: unknown): void {
  const type = typeof block === "object" && block !== null && "type" in block ? block.type : block;
  console.warn(`跳过未知内容块 (entry ${entryId}): ${String(type)}`);
}

function mapUsage(message: AssistantMessage): ChatMessageUsage | undefined {
  const usage = message.usage;
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    ...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
    totalTokens: usage.totalTokens,
    uncachedInputTokens: usage.input,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
  };
}

function mapUserMessage(
  entryId: string,
  message: UserMessage,
  createdAt: number,
  parentId: string | null,
): ChatMessage {
  const parts: ChatPart[] = [];
  if (typeof message.content === "string") {
    if (message.content.trim().length > 0) parts.push({ type: "text", text: message.content });
  } else {
    for (const block of message.content) {
      if (block.type === "text") {
        if (block.text.trim().length > 0) parts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        parts.push({
          type: "image",
          mimeType: block.mimeType,
          dataUrl: toDataUrl(block.mimeType, block.data),
        });
      } else {
        warnUnknownBlock(entryId, block);
      }
    }
  }
  return { id: entryId, entryId, parentId, role: "user", createdAt, parts, status: "complete" };
}

function mapAssistantMessage(
  entryId: string,
  message: AssistantMessage,
  createdAt: number,
  pending: PendingToolCalls,
  parentId: string | null,
): ChatMessage {
  const parts: ChatPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) parts.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      // 被安全策略屏蔽的 thinking 只有加密签名，没有可展示文本
      if (block.redacted !== true && block.thinking.trim().length > 0) {
        parts.push({ type: "reasoning", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const part: ToolCallPart = {
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        // 流式期间 args 可能不完整；落盘条目已是最终结构，这里直接序列化原值
        argsText: JSON.stringify(block.arguments) ?? "{}",
        args: block.arguments,
        // 有对应 toolResult 时会在后续条目里改写为 done/error
        status: "running",
      };
      pending.set(block.id, part);
      parts.push(part);
    } else {
      warnUnknownBlock(entryId, block);
    }
  }

  const failed = message.stopReason === "error" || message.stopReason === "aborted";
  const usage = mapUsage(message);
  return {
    id: entryId,
    entryId,
    parentId,
    role: "assistant",
    createdAt,
    parts,
    status: failed ? "error" : "complete",
    ...(usage === undefined ? {} : { usage }),
    ...(failed && message.errorMessage ? { error: message.errorMessage } : {}),
  };
}

/** 工具结果内容：优先纯文本，其次结构化 details，最后原样保留内容块 */
function toolResultValue(message: ToolResultMessage): unknown {
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (text.length > 0) return text;
  if (message.details !== undefined) return message.details;
  if (message.content.length > 0) return message.content;
  return "";
}

function applyToolResult(message: ToolResultMessage, pending: PendingToolCalls): void {
  const part = pending.get(message.toolCallId);
  // 找不到匹配调用的结果直接忽略（可能来自分支外的历史残留）
  if (!part) return;
  part.result = toolResultValue(message);
  // 文本结果会盖住 details，两者都留：工具的结构化详情（edit 的 patch 等）只有 details 里有
  if (message.details !== undefined) part.details = message.details;
  part.isError = message.isError;
  part.status = message.isError ? "error" : "done";
}

/**
 * Entry 列表（按时间正序）→ UI 消息。
 * 忽略 compaction / branch_summary / custom 条目本身，仅收集压缩摘要文本预览；
 * 每个 message 条目保持一条 ChatMessage（不跨条目合并），保证 entryId 精确对应分支点。
 */
export function mapEntriesToMessages(entries: Entry[]): {
  messages: ChatMessage[];
  compactionSummaries: string[];
} {
  const messages: ChatMessage[] = [];
  const compactionSummaries: string[] = [];
  const pending: PendingToolCalls = new Map();

  for (const entry of entries) {
    if (entry.type === "compaction") {
      compactionSummaries.push(entry.summary);
      continue;
    }
    if (entry.type !== "message") continue;

    const { message } = entry;
    const createdAt = entry.timestamp || message.timestamp;
    if (message.role === "user") {
      messages.push(mapUserMessage(entry.id, message, createdAt, entry.parentId));
    } else if (message.role === "assistant") {
      messages.push(mapAssistantMessage(entry.id, message, createdAt, pending, entry.parentId));
    } else if (message.role === "toolResult") {
      // toolResult 是独立消息条目：只回填对应 tool-call，不单独成条
      applyToolResult(message, pending);
    } else {
      const role = (message as { role?: unknown }).role;
      console.warn(`跳过未知消息角色 (entry ${entry.id}): ${String(role)}`);
    }
  }

  return { messages, compactionSummaries };
}
