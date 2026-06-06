// 工具调用显示组件
// src/components/ToolCallDisplay.tsx

import { Check, Loader2, X } from "lucide-react";

export interface ToolCall {
  id: string;
  skillId: string;
  toolName: string;
  status: "pending" | "running" | "success" | "error";
  parameters?: Record<string, any>;
  result?: any;
  error?: string;
  startTime?: number;
  endTime?: number;
}

interface ToolCallDisplayProps {
  toolCall: ToolCall;
}

export function ToolCallDisplay({ toolCall }: ToolCallDisplayProps) {
  const duration =
    toolCall.startTime && toolCall.endTime
      ? toolCall.endTime - toolCall.startTime
      : null;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Status Icon */}
          {toolCall.status === "running" && (
            <Loader2 className="size-4 animate-spin text-blue-500" />
          )}
          {toolCall.status === "success" && (
            <Check className="size-4 text-green-500" />
          )}
          {toolCall.status === "error" && <X className="size-4 text-red-500" />}

          {/* Tool Name */}
          <span className="font-medium">
            {toolCall.skillId}.{toolCall.toolName}
          </span>
        </div>

        {/* Duration */}
        {duration !== null && (
          <span className="text-xs text-muted-foreground">{duration}ms</span>
        )}
      </div>

      {/* Parameters */}
      {toolCall.parameters && Object.keys(toolCall.parameters).length > 0 && (
        <div className="mt-2 text-xs">
          <span className="text-muted-foreground">参数: </span>
          <code className="rounded bg-muted px-1 py-0.5">
            {JSON.stringify(toolCall.parameters, null, 2)}
          </code>
        </div>
      )}

      {/* Result */}
      {toolCall.status === "success" && toolCall.result && (
        <div className="mt-2 rounded bg-green-500/10 px-2 py-1 text-xs text-green-700 dark:text-green-400">
          <span className="font-medium">结果: </span>
          {typeof toolCall.result === "string"
            ? toolCall.result
            : JSON.stringify(toolCall.result)}
        </div>
      )}

      {/* Error */}
      {toolCall.status === "error" && toolCall.error && (
        <div className="mt-2 rounded bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-400">
          <span className="font-medium">错误: </span>
          {toolCall.error}
        </div>
      )}
    </div>
  );
}
