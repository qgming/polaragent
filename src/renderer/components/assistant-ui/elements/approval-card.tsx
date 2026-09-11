"use client";

import { CheckIcon, Loader2Icon, TerminalIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { field, inkButton, paper } from "./surfaces";

export type ApprovalState = "request" | "running" | "done" | "denied";

/** 卡片文案：调用方传本地化文案，缺省回落英文（元素单独使用时也立得住） */
export interface ApprovalCardLabels {
  allowOnce?: string;
  alwaysAllow?: string;
  deny?: string;
  /** 「审批中」态文案：AI 预审出结论前显示 */
  running?: string;
}

const DEFAULT_LABELS: Required<ApprovalCardLabels> = {
  allowOnce: "Allow once",
  alwaysAllow: "Always allow",
  deny: "Deny",
  running: "Approved, running",
};

export function ApprovalCard({
  state,
  command,
  title,
  subtitle,
  reason,
  labels,
  onAllowOnce,
  onAlwaysAllow,
  onDeny,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "state"
  | "command"
  | "title"
  | "subtitle"
  | "onAllowOnce"
  | "onAlwaysAllow"
  | "onDeny"
> & {
  state: ApprovalState;
  command: string;
  title: string;
  subtitle: string;
  /** 审批结论：AI 拒绝或调用失败时的理由，交回用户时展示 */
  reason?: string;
  labels?: ApprovalCardLabels;
  onAllowOnce?: () => void;
  onAlwaysAllow?: () => void;
  onDeny?: () => void;
}) {
  return (
    <div
      data-slot="approval-card"
      className={cn(paper, "flex w-full max-w-sm flex-col gap-3.5 rounded-[20px] p-4", className)}
      {...props}
    >
      <div className="flex items-center gap-3">
        <span className="bg-foreground/[0.05] text-foreground/45 flex size-9 shrink-0 items-center justify-center rounded-xl">
          <TerminalIcon className="size-4" />
        </span>
        <div className="flex flex-col">
          <p className="text-[13.5px] font-medium">{title}</p>
          <p className="text-foreground/45 text-xs">{subtitle}</p>
        </div>
      </div>

      <div className={cn(field, "text-foreground/70 rounded-xl px-3.5 py-2.5 font-mono text-xs")}>
        {command}
      </div>

      {/* 理由只在有结论时出现（AI 交回用户）；没有结论的普通请求不占位 */}
      {reason !== undefined && reason !== "" ? (
        <p className="text-foreground/55 text-xs leading-relaxed">{reason}</p>
      ) : null}

      <div className="flex h-8 items-center justify-end gap-2">
        {state === "request" ? (
          <>
            <button
              type="button"
              onClick={onDeny}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              {labels?.deny ?? DEFAULT_LABELS.deny}
            </button>
            <button
              type="button"
              onClick={onAlwaysAllow}
              className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
            >
              {labels?.alwaysAllow ?? DEFAULT_LABELS.alwaysAllow}
            </button>
            <button
              type="button"
              onClick={onAllowOnce}
              className={cn(
                inkButton,
                "flex h-8 items-center rounded-full px-3.5 text-xs font-medium",
              )}
            >
              {labels?.allowOnce ?? DEFAULT_LABELS.allowOnce}
            </button>
          </>
        ) : (
          <div
            key={state}
            className="fade-in animate-in text-foreground/55 flex items-center gap-2 text-xs duration-300"
          >
            {state === "running" ? (
              <>
                <Loader2Icon className="text-foreground/45 size-3.5 animate-spin" />
                {labels?.running ?? DEFAULT_LABELS.running}
              </>
            ) : state === "denied" ? (
              <>
                <XIcon className="text-foreground/45 size-3.5" />
                Denied
              </>
            ) : (
              <>
                <CheckIcon className="size-3.5 text-emerald-500" />
                Finished with exit 0
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
