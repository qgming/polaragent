import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { Check, ChevronDown, Terminal, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";

/** 结果可能是任意 JSON 或字符串：统一序列化展示，保持 mono 低对比 */
function formatResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

/**
 * 默认工具调用渲染（B2 ③ 单行展开）：一行眉题（工具名 + 参数摘要 + 状态），
 * 展开后显示参数与结果（等宽字体）。工具调用组由 ToolGroup 折叠。
 */
export const ToolFallback: ToolCallMessagePartComponent = (props) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { toolName, argsText, result, isError, status } = props;

  const running = status.type === "running";
  const failed = isError === true || status.type === "incomplete";

  return (
    <div className="rounded-sm border border-border bg-card px-2 py-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-mono text-xs font-medium">{toolName}</span>
        {/* 参数摘要：单行截断，等宽字体 */}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
          {argsText}
        </span>
        {running ? (
          // tw-shimmer 需在 CSS 中 @import 才生效，index.css 禁改，改用 animate-pulse
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-brand-text">
            <span className="size-1.5 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
            {t("chat.running")}
          </span>
        ) : failed ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="mt-2 space-y-1.5 border-t border-border pt-1.5">
          <pre className="max-h-40 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-muted-foreground">
            {argsText}
          </pre>
          {result !== undefined && (
            <pre
              className={cn(
                "max-h-40 overflow-y-auto font-mono text-xs leading-relaxed whitespace-pre-wrap break-all",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {formatResult(result)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
