// 会话历史回读与解析：把 jsonl 的 message/toolResult/custom 条目重建为 UI 用的
// ChatMessage[]（含 assistant 的有序 parts）。
import { BACKGROUND_CONTEXT, JsonlSessionRepo } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { calculateContextTokens } from "@/lib/session/compaction";
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
  ChatMessageMetadata,
} from "@/lib/chat";
import { extractMessageParts } from "@/lib/chat";
import { toolDisplayName } from "@/ai/tools";
import { getRepo } from "./session-repo";
import { pickBestMeta } from "./meta-selection";
import { GUIDANCE_ENTRY } from "./entries";

/**
 * 回读某会话的历史消息，重建为 UI 用的 ChatMessage[]（含 assistant 的 parts）。
 *
 * pi 的 session 把每条 user / assistant / toolResult 作为独立 message 存储。
 * 这里按顺序遍历：
 *   - user      -> 一条用户 ChatMessage（取纯文本）
 *   - assistant -> 一条助手 ChatMessage，content 为有序 parts
 *   - toolResult-> 不单独成条，按 toolCallId 回填到对应 assistant 的 tool-call part
 */
export async function loadChatMessages(
  sessionId: string,
): Promise<ChatMessage[]> {
  return loadChatMessagesImpl(sessionId, getRepo);
}

async function loadChatMessagesImpl(
  sessionId: string,
  repoGetter: () => Promise<JsonlSessionRepo>,
): Promise<ChatMessage[]> {
  const repo = await repoGetter();
  const metas = await repo.list(undefined, BACKGROUND_CONTEXT).catch(() => []);
  const hits = metas.filter((meta) => meta.id === sessionId);
  if (hits.length === 0) return [];

  // 同 id 多条时读「内容最多」的那条，确保回读到有消息的会话而非空壳
  const best = await pickBestMeta(hits);
  const session = await repo.open(best, BACKGROUND_CONTEXT);
  const branch = await session.findEntries({ order: "asc" }, BACKGROUND_CONTEXT).catch(() => []);

  // 先收集所有 toolResult，按 toolCallId 建索引，供 assistant 的 tool-call part 回填
  const toolResults = new Map<
    string,
    {
      label: string;
      isError: boolean;
      resultText?: string;
      details?: Record<string, unknown>;
    }
  >();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "toolResult") {
      toolResults.set(message.toolCallId, {
        label: toolDisplayName(message.toolName),
        isError: message.isError,
        resultText: toolResultDetailsText(message.details),
        details: extractDetails(message.details),
      });
    }
  }

  const messages: ChatMessage[] = [];

  // 一次用户提问可能触发 agent 多轮调用，产生多条相邻的 assistant 消息
  // （中间夹着 toolResult）。这里把「相邻的 assistant」合并为一条 ChatMessage，
  // parts 按序拼接，与实时运行时聚合为「一整条消息」的结构保持一致。
  // 遇到 user 消息即断开。
  let pending: {
    id: string;
    createdAt: number;
    parts: ChatMessagePart[];
    metadata: ChatMessageMetadata;
  } | null = null;
  const pendingGuidance: Array<{ text: string; createdAt: number }> = [];

  // 把累积中的助手消息落地为一条 ChatMessage
  const flushPending = () => {
    if (!pending || pending.parts.length === 0) {
      pending = null;
      return;
    }
    const hasMetadata = Object.values(pending.metadata).some((v) => v !== undefined);
    messages.push({
      id: pending.id,
      role: "assistant",
      content: pending.parts,
      createdAt: pending.createdAt,
      status: "complete",
      metadata: hasMetadata ? pending.metadata : undefined,
    });
    pending = null;
  };

  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === GUIDANCE_ENTRY) {
      const data = entry.data as { text?: unknown; createdAt?: unknown } | undefined;
      if (data && typeof data.text === "string" && data.text.trim()) {
        pendingGuidance.push({
          text: data.text.trim(),
          createdAt:
            typeof data.createdAt === "number"
              ? data.createdAt
              : entry.timestamp || 0,
        });
      }
      continue;
    }

    if (entry.type !== "message") continue;
    const message = entry.message;
    const timestamp = entry.timestamp || message.timestamp || 0;

    if (message.role === "user") {
      const text = userMessageText(message);
      const attachments = userMessageAttachments(message);

      // 新的用户消息 -> 先落地累积的助手消息，断开合并
      flushPending();

      // 从待处理 guidance 队列中查找与当前用户消息文本匹配的 guidance。
      // guidance 条目在用户消息之前写入，回读时应归属到对应的用户消息中。
      const guidanceParts: ChatMessagePart[] = [];
      const guidanceIndex = pendingGuidance.findIndex(
        (guidance) => guidance.text === text.trim(),
      );
      if (guidanceIndex >= 0) {
        const [guidance] = pendingGuidance.splice(guidanceIndex, 1);
        guidanceParts.push({
          type: "data-polar-guidance",
          data: { text: guidance.text, createdAt: guidance.createdAt },
        });
      }

      // 仅当正文与附件都为空时才跳过；纯附件消息（只发图片/文件无文字）需保留
      if (
        text.trim().length === 0 &&
        attachments.length === 0 &&
        guidanceParts.length === 0
      ) {
        continue;
      }

      // 构建用户消息：guidance part 在前，正文 text part 在后
      const userContent: ChatMessagePart[] = [...guidanceParts];
      if (text.trim().length > 0) {
        userContent.push({ type: "text", text });
      }
      messages.push({
        id: entry.id,
        role: "user",
        content: userContent,
        createdAt: timestamp,
        status: "complete",
        attachments,
      });
    } else if (message.role === "assistant") {
      const parts = extractMessageParts(message, toolResults);
      if (parts.length === 0) continue;
      // 追加到当前累积；id/时间取该组最后一条（与实时聚合一致）
      if (!pending) {
        pending = {
          id: entry.id,
          createdAt: timestamp,
          parts: [...parts],
          metadata: {
            model: message.model,
            // 每轮总量与上下文都用官方口径 calculateContextTokens
            // （= totalTokens || input+output+cacheRead+cacheWrite），
            // 与实时路径（src/ai/agent.ts buildAgentEndResult）保持一致
            tokenCount: message.usage ? calculateContextTokens(message.usage) : undefined,
            inputTokens: message.usage?.input,
            outputTokens: message.usage?.output,
            cacheWriteTokens: message.usage?.cacheWrite,
            cacheReadTokens: message.usage?.cacheRead,
            contextTokens: message.usage ? calculateContextTokens(message.usage) : undefined,
          },
        };
      } else {
        pending.id = entry.id;
        pending.createdAt = timestamp;
        pending.parts.push(...parts);
        pending.metadata.model = message.model ?? pending.metadata.model;
        // 累加所有轮次的 token（口径同上）
        pending.metadata.tokenCount =
          (pending.metadata.tokenCount ?? 0) +
          (message.usage ? calculateContextTokens(message.usage) : 0);
        pending.metadata.inputTokens =
          (pending.metadata.inputTokens ?? 0) + (message.usage?.input ?? 0);
        pending.metadata.outputTokens =
          (pending.metadata.outputTokens ?? 0) + (message.usage?.output ?? 0);
        pending.metadata.cacheWriteTokens =
          (pending.metadata.cacheWriteTokens ?? 0) + (message.usage?.cacheWrite ?? 0);
        pending.metadata.cacheReadTokens =
          (pending.metadata.cacheReadTokens ?? 0) + (message.usage?.cacheRead ?? 0);
        // 当前上下文大小取最后一轮的官方口径总量
        pending.metadata.contextTokens = message.usage
          ? calculateContextTokens(message.usage)
          : pending.metadata.contextTokens;
      }
    }
    // toolResult 已在上面收集，不单独成条
  }

  // 尾部可能还有未落地的助手消息
  flushPending();

  return messages;
}

// 剥离后台注入的文件块 <file …>…</file> 与图片块 <image …>…</image>：
// 这些块是 "@" 选中文件时拼进发送内容的文件全文，供模型读取，
// 不应在 UI 对话记录里显示。回读时移除所有此类块及其后随空白，仅保留用户问题。
function stripAttachmentBlocks(text: string): string {
  return text
    .replace(/<file\b[^>]*>[\s\S]*?<\/file>\s*/g, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image>\s*/g, "")
    .trim();
}

function attrValue(source: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`),
  );
  return match?.[1] ?? match?.[2];
}

function rawUserText(
  message: Extract<AgentMessage, { role: "user" }>,
  separator = "\n",
): string {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .filter(Boolean)
        .join(separator);
}

function userMessageAttachments(
  message: Extract<AgentMessage, { role: "user" }>,
): ChatAttachment[] {
  const rawText = rawUserText(message);
  const attachments: ChatAttachment[] = [];
  const seen = new Set<string>();
  for (const match of rawText.matchAll(/<file\b([^>]*)>[\s\S]*?<\/file>/g)) {
    const attrs = match[1] ?? "";
    const path = attrValue(attrs, "path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push({
      path,
      name: attrValue(attrs, "name") ?? path.split(/[\\/]/).pop() ?? path,
      kind: "text",
    });
  }
  for (const match of rawText.matchAll(/<image\b([^>]*)>[\s\S]*?<\/image>/g)) {
    const attrs = match[1] ?? "";
    const path = attrValue(attrs, "path");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    attachments.push({
      path,
      name: attrValue(attrs, "name") ?? path.split(/[\\/]/).pop() ?? path,
      kind: "image",
    });
  }
  return attachments;
}

// 取用户消息的纯文本（content 可能是 string 或 (text|image)[]），并剥离附件块
function userMessageText(message: Extract<AgentMessage, { role: "user" }>): string {
  return stripAttachmentBlocks(rawUserText(message, ""));
}

// 从 toolResult.details 中提取完整的 details 对象
function extractDetails(details: unknown): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return undefined;
  return details as Record<string, unknown>;
}

// 工具结果 details -> 完整可读文本（供步骤项点击展开查看）
function toolResultDetailsText(details: unknown): string | undefined {
  if (details === undefined || details === null) return undefined;
  if (typeof details === "string") {
    return details.trim() || undefined;
  }
  if (typeof details === "object") {
    try {
      return JSON.stringify(details, null, 2);
    } catch {
      return undefined;
    }
  }
  return String(details);
}
