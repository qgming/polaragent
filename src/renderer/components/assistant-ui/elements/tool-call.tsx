"use client";

import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { collapsePanel, field, mono, ShimmerLabel, SwapLabel } from "./surfaces";

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  request: string;
  result: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 可选的详情渲染：给了就替掉内置的 Request/Result 文本面板。
   * 用于把结果交给更贴的组件（终端块、diff 等）——那些组件自带外观，所以不再套外层灰底框。
   */
  detail?: ReactNode;
  /**
   * 调用失败：整行转红、收尾标记换成红叉。
   * 必须由调用方显式传入 —— 这个组件从 part 上拿不到失败信息（aui 的 part status 只表达
   * 「跑没跑完」，「有没有报错」在本仓是 isError 这个独立字段）。
   */
  isError?: boolean;
  className?: string;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  request,
  result,
  running,
  open,
  onOpenChange,
  detail,
  isError = false,
  className,
}: ToolCallProps) {
  // 纵向间距交给父容器的 gap（与正文段落、思考块同为 12px），块自身不带到外边距
  return (
    <Collapsible
      data-slot="tool-call"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger
        className={cn(
          "group/trigger text-foreground/55 hover:text-foreground/90 flex items-center gap-2 rounded-md py-0 text-[13.5px] transition-colors outline-none",
          isError &&
            "text-red-600/85 hover:text-red-600 dark:text-red-400/85 dark:hover:text-red-400",
        )}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={running ? 0 : 1} className="text-start">
          <ShimmerLabel active={running} className="relative inline-block leading-none">
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/70 min-w-0 truncate rounded-md px-1.5 py-0.5",
          )}
        >
          {query}
        </span>
        <span className="ms-auto flex w-4 items-center justify-end">
          {!running &&
            (isError ? (
              <XIcon className="fade-in zoom-in-90 animate-in size-3.5 text-red-600 duration-200 dark:text-red-400" />
            ) : (
              <CheckIcon className="fade-in zoom-in-90 animate-in size-3.5 text-emerald-500 duration-200" />
            ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {detail !== undefined ? (
          /*
            工具详情（bash 输出 / diff / 内置面板）与触发行之间的间距走 --density-gap-inner：
            它是块内条目，比块间距紧一档（舒适 12px / 紧凑 8px）。
          */
          <div className="mt-(--density-gap-inner)">{detail}</div>
        ) : (
          <div
            className={cn(
              field,
              // 相对正文缩放（12/14 基准）：面板里的正文跟随对话字号
              "mt-(--density-gap-inner) overflow-hidden rounded-2xl text-[0.86em]",
            )}
          >
            <div className="px-3.5 pt-2.5 pb-2">
              <p className={cn(mono, "text-foreground/35 mb-1")}>Request</p>
              <p className="text-foreground/55 font-mono">{request}</p>
            </div>
            <div className="bg-foreground/[0.06] mx-3.5 h-px" />
            <div className="px-3.5 pt-2 pb-2.5">
              <p className={cn(mono, "text-foreground/35 mb-1")}>Result</p>
              <p className="text-foreground/90">{result}</p>
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
