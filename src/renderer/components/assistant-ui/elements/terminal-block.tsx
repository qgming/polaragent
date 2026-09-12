"use client";

import { CheckIcon, Loader2Icon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { take } from "../utils/range";
import { mono, paper } from "./surfaces";

export function TerminalBlock({
  command,
  lines,
  visibleCount,
  done,
  variant = "paper",
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "command" | "lines" | "visibleCount" | "done" | "variant"
> & {
  command: string;
  lines: readonly string[];
  visibleCount: number;
  done: boolean;
  variant?: "paper" | "ink";
}) {
  const ink = variant === "ink";

  return (
    <div
      data-slot="terminal-block"
      className={cn(
        ink ? "bg-foreground dark:bg-popover" : paper,
        // 相对正文缩放（12/14 基准）：终端输出跟随对话字号
        "w-full overflow-hidden rounded-2xl font-mono text-[0.86em]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-3 pb-1.5">
        <span
          // 命令常比面板宽：单行省略，不换行也不把右侧的 exit 挤出边界（根是 overflow-hidden）
          className={cn(
            "min-w-0 truncate",
            ink ? "text-background/90 dark:text-foreground" : "text-foreground",
          )}
          title={command}
        >
          {command}
        </span>
        {done ? (
          <div className="flex shrink-0 items-center gap-1">
            <CheckIcon className="size-3 text-emerald-500" />
            <span className={cn(mono, ink ? "text-background/40 dark:text-ink-4" : "text-ink-4")}>
              exit 0
            </span>
          </div>
        ) : (
          <Loader2Icon
            className={cn(
              "size-3 shrink-0 animate-spin motion-reduce:animate-none",
              ink ? "text-background/35 dark:text-ink-4" : "text-ink-4",
            )}
          />
        )}
      </div>
      <div
        className={cn(
          "flex min-h-[8.5rem] flex-col gap-1 px-4 pt-1 pb-3.5",
          ink ? "text-background/55 dark:text-ink-3" : "text-ink-3",
        )}
      >
        {take(lines, visibleCount).map((line, i) => {
          const isLast = i === lines.length - 1;
          return (
            <div
              key={`${i}-${line}`}
              className={cn(
                // 长输出行按面板宽度换行，不横向溢出（根是 overflow-hidden，溢出等于被裁）
                "fade-in animate-in fill-mode-both break-words whitespace-pre-wrap duration-300",
                isLast && (ink ? "text-background/90 dark:text-foreground" : "text-foreground"),
              )}
            >
              {line}
            </div>
          );
        })}
        {!done && (
          <span
            aria-hidden
            className="inline-block h-3 w-1.5 animate-pulse bg-blue-500/70 motion-reduce:animate-none dark:bg-blue-400/70"
          />
        )}
      </div>
    </div>
  );
}
