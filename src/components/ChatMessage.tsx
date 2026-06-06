// 消息组件（使用 react-markdown）
// src/components/ChatMessage.tsx

import { Bot, User, Clock } from "lucide-react";
import { MarkdownContent } from "@/components/MarkdownContent";
import { ToolCallDisplay, type ToolCall } from "./ToolCallDisplay";

interface ChatMessageProps {
  role: "user" | "assistant";
  content: string;
  timestamp?: number;
  toolCalls?: ToolCall[];
  model?: string;
}

export function ChatMessage({
  role,
  content,
  timestamp,
  toolCalls,
  model,
}: ChatMessageProps) {
  const isUser = role === "user";

  const formatTime = (ts?: number) => {
    if (!ts) return "";
    const date = new Date(ts);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return date.toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return date.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div
      className={`flex gap-4 py-6 ${isUser ? "bg-background" : "bg-muted/30"}`}
    >
      <div className="mx-auto flex w-full max-w-4xl gap-4 px-6">
        {/* Avatar */}
        <div
          className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground"
          }`}
        >
          {isUser ? <User className="size-5" /> : <Bot className="size-5" />}
        </div>

        {/* Content */}
        <div className="flex-1 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-2">
            <span className="font-semibold">
              {isUser ? "You" : "Assistant"}
            </span>
            {model && !isUser && (
              <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                {model}
              </span>
            )}
            {timestamp && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="size-3" />
                {formatTime(timestamp)}
              </div>
            )}
          </div>

          {/* Tool Calls */}
          {toolCalls && toolCalls.length > 0 && (
            <div className="space-y-2">
              {toolCalls.map((toolCall) => (
                <ToolCallDisplay key={toolCall.id} toolCall={toolCall} />
              ))}
            </div>
          )}

          {/* Message Content - Markdown */}
          <MarkdownContent content={content} />
        </div>
      </div>
    </div>
  );
}
