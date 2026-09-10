import { useAuiState } from "@assistant-ui/react";
import { ChevronDown, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";

interface ToolGroupProps {
  startIndex: number;
  endIndex: number;
  children?: ReactNode;
}

/**
 * 连续工具调用分组（B2 ③）：默认折叠为一行 mono 眉题「工具调用 · N」，
 * 运行中追加「正在运行 <名称>」脉冲提示；展开后逐条列出子工具调用。
 */
export function ToolGroup({ startIndex, endIndex, children }: ToolGroupProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const count = endIndex - startIndex + 1;

  // 从 message 级 parts 里找组内第一个运行中的工具名（part 作用域内 s.message 可读）
  const runningTool = useAuiState((s) => {
    const parts = s.message.parts.slice(startIndex, endIndex + 1);
    const running = parts.find((p) => p.type === "tool-call" && p.status.type === "running");
    return running?.type === "tool-call" ? running.toolName : undefined;
  });

  return (
    <div className="mb-2 rounded-sm border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
      >
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-[11px] text-muted-foreground">
          {t("chat.toolCalls")} · {count}
        </span>
        {runningTool !== undefined && (
          // tw-shimmer 需在 CSS 中 @import 才生效，index.css 禁改，改用 animate-pulse
          <span className="flex min-w-0 items-center gap-1 font-mono text-[11px] text-brand-text">
            <span className="size-1.5 shrink-0 rounded-full bg-brand animate-pulse motion-reduce:animate-none" />
            <span className="truncate">
              {t("chat.running")} {runningTool}
            </span>
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      {open && <div className="space-y-1.5 border-t border-border px-2 py-1.5">{children}</div>}
    </div>
  );
}
