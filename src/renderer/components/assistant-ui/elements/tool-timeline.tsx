"use client";

import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { take } from "../utils/range";
import { collapsePanel, ShimmerLabel, SwapLabel } from "./surfaces";

export interface TimelineStep {
  verb: string;
  chip: string;
  icon: LucideIcon;
  /**
   * 可选的该步详情，展开时以返回值为内容。
   *
   * 用渲染函数而不是节点，是为了让调用侧按需取数：开关状态在本组件内，
   * 只有拿到 `open` 才能做到「没展开的步骤不去读它那份可能很大的结果」。
   */
  detail?: (open: boolean) => ReactNode;
}

export interface TimelineStat {
  file: string;
  added?: number;
  removed?: number;
}

export interface ToolTimelineProps {
  steps: readonly TimelineStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  stats: TimelineStat[];
  className?: string;
}

export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  stats,
  className,
}: ToolTimelineProps) {
  // 展开的步骤下标集合：可同时展开多步，便于对照
  const [openSteps, setOpenSteps] = useState<ReadonlySet<number>>(() => new Set());

  const setStepOpen = (index: number, open: boolean) => {
    setOpenSteps((prev) => {
      const next = new Set(prev);
      if (open) next.add(index);
      else next.delete(index);
      return next;
    });
  };

  // 纵向间距交给父容器的 gap（与正文段落、思考块同为 12px），块自身不带到外边距
  return (
    <Collapsible
      data-slot="tool-timeline"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger className="group/trigger text-ink-3 hover:text-foreground flex items-center gap-1.5 rounded-md py-0 text-[13.5px] transition-colors outline-none">
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={streaming ? 0 : 1} className="text-start tabular-nums">
          <ShimmerLabel active={streaming} className="relative inline-block leading-none">
            {activeLabel}
          </ShimmerLabel>
          <>{restingLabel}</>
        </SwapLabel>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {/* 步骤之间走 --density-gap-inner（块内条目）：舒适 12px / 紧凑 8px */}
        <div className="flex flex-col gap-(--density-gap-inner) ps-4 pt-2.5">
          {take(steps, visibleSteps).map((step, index, shown) => {
            const Icon = step.icon;
            const active = streaming && index === shown.length - 1;
            const stepDetail = step.detail;
            const stepOpen = openSteps.has(index);
            // 下标进 key：嵌套折叠的开关状态挂在行上，同名 chip 会串位
            const key = `${index}-${step.chip}`;

            const row = (
              <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-ink-3 flex min-w-0 items-center gap-2 text-[13.5px] duration-300">
                <Icon className="text-ink-4 size-3.5 shrink-0" />
                <ShimmerLabel
                  active={active}
                  className="relative inline-block shrink-0 leading-none whitespace-nowrap"
                >
                  {step.verb}
                </ShimmerLabel>
                {/*
                  参数 chip：**没有主参数时不渲染**。
                  ask_user 的参数是 questions 数组（里面没有一个字符串），
                  无条件渲染会在行上留下一枚只有 padding 的空灰胶囊 —— 看起来像渲染 bug。
                  与 ToolCall 的触发行同一口径（那边也有同样的判断）。
                */}
                {step.chip !== "" && (
                  <span className="bg-foreground/[0.06] text-ink-2 min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-[11px]">
                    {step.chip}
                  </span>
                )}
                {stepDetail !== undefined && (
                  <ChevronRightIcon className="size-3 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/step-trigger:rotate-90 motion-reduce:transition-none" />
                )}
              </div>
            );

            if (stepDetail === undefined) {
              return <div key={key}>{row}</div>;
            }

            return (
              <Collapsible
                key={key}
                open={stepOpen}
                onOpenChange={(next) => setStepOpen(index, next)}
                className="group/step flex flex-col"
              >
                <CollapsibleTrigger className="group/step-trigger w-full rounded-md text-start outline-none">
                  {row}
                </CollapsibleTrigger>
                <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
                  <div className="pt-2">{stepDetail(stepOpen)}</div>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
          {stats.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {stats.map((stat) => (
                <span
                  key={stat.file}
                  className="bg-foreground/[0.06] text-ink-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]"
                >
                  <span>{stat.file}</span>
                  {stat.added !== undefined && (
                    <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>
                  )}
                  {stat.removed !== undefined && (
                    <span className="text-red-600 dark:text-red-400">−{stat.removed}</span>
                  )}
                </span>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
