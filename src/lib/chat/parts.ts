// pi-sdk AgentMessage → ChatMessagePart 提取
// src/lib/chat/parts.ts

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { toolDisplayName } from "@/ai/tools";
import type { ChatMessagePart, ToolCallPart } from "./types";

export interface ToolResultSummary {
  label: string;
  isError: boolean;
  pending?: boolean;
  resultText?: string;
  details?: Record<string, unknown>;
}

/**
 * 从 assistant 消息的有序 content blocks 提取 ChatMessagePart。
 * pi 的顺序即模型产出真实顺序：text / thinking / toolCall 交错。
 */
export function extractMessageParts(
  message: AgentMessage & { role: "assistant" },
  toolResults: Map<string, ToolResultSummary>,
): ChatMessagePart[] {
  const parts: ChatMessagePart[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text.trim().length > 0) {
        parts.push({ type: "text", text: block.text });
      }
    } else if (block.type === "thinking") {
      if (block.thinking.trim().length > 0) {
        parts.push({ type: "reasoning", text: block.thinking });
      }
    } else if (block.type === "toolCall") {
      const result = toolResults.get(block.id);
      const rawArgs =
        (block as { args?: unknown; arguments?: unknown }).args ??
        (block as { arguments?: unknown }).arguments;
      const args =
        rawArgs && typeof rawArgs === "object"
          ? (rawArgs as Record<string, unknown>)
          : {};
      const status = result
        ? result.pending
          ? ("running" as const)
          : result.isError
            ? ("error" as const)
            : ("complete" as const)
        : ("running" as const);
      const toolPart: ToolCallPart = {
        type: "tool-call",
        toolCallId: block.id,
        toolName: block.name,
        args,
        argsText: JSON.stringify(args),
        // 已完成的工具必须有 result（可为空串），否则 aui 会继承 message.status 持续 spinner
        result:
          status === "running" ? undefined : (
            (result?.resultText ?? result?.details ?? "")
          ),
        isError: result?.isError,
        label: result?.label ?? toolDisplayName(block.name),
        polar: {
          status,
          resultText: result?.resultText,
          details: result?.details,
        },
      };
      parts.push(toolPart);
    }
  }

  return parts;
}
