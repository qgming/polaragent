"use client";

import { CheckIcon, PauseIcon, RotateCcwIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { mono, paper } from "./surfaces";

export type AgentState = "working" | "waiting" | "done";

export interface StatusStep {
  state: AgentState;
  label: string;
  /** 已经跑出来的耗时（如 "12s"）；元素只在非 done 时显示它 */
  elapsed?: string;
}

export function AgentStatus({
  state,
  label,
  elapsed,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "state" | "label" | "elapsed"> & {
  state: AgentState;
  label: string;
  elapsed?: string;
}) {
  return (
    <div
      data-slot="agent-status"
      className={cn(
        paper,
        "flex items-center gap-2.5 rounded-full py-1.5 ps-3.5 pe-1.5",
        className,
      )}
      {...props}
    >
      {state === "done" ? (
        <CheckIcon aria-hidden className="size-3 shrink-0 text-emerald-500" />
      ) : (
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full motion-reduce:animate-none",
            state === "working"
              ? "animate-pulse bg-blue-500 dark:bg-blue-400"
              : "border-foreground/35 border",
          )}
        />
      )}
      <span className="sr-only">{state}</span>
      <span
        key={label}
        className="fade-in blur-in-[2px] animate-in max-w-44 truncate text-xs duration-300 motion-reduce:animate-none"
      >
        {label}
      </span>
      {elapsed !== undefined && state !== "done" && (
        <span className={cn(mono, "text-ink-4 tabular-nums")}>{elapsed}</span>
      )}
      <span aria-hidden className="text-ink-3 flex size-6 items-center justify-center rounded-full">
        {state === "done" ? <RotateCcwIcon className="size-3" /> : <PauseIcon className="size-3" />}
      </span>
    </div>
  );
}

/**
 * 一组状态 pill（多行时自上而下竖排）。
 *
 * 列表形态为什么留在元素里、而不是由调用方自己 map：
 * `StatusStep` 从第一天起就是这个元素的公开类型，只是从来没写过生产者 —— 一次委派要显示
 * 「谁、在干什么、多久」时，调用方只能各写一遍自己的行。而一个步骤就是一个 AgentStatus，
 * 多个步骤不过是同一个东西重复几遍：间距、顺序、key 的口径必须与单行完全一致，
 * 放在这里才算把当初留下的那个类型补齐，而不是在外面拼一套长得差不多的东西。
 */
export function AgentStatusList({
  steps,
  className,
}: {
  steps: readonly StatusStep[];
  className?: string;
}) {
  return (
    <div data-slot="agent-status-list" className={cn("flex flex-col gap-1.5", className)}>
      {steps.map((step, index) => (
        // 下标当 key：StatusStep 没有 id，而一组步骤在一次调用里是固定长度、固定顺序的
        // （委派顺序）。拿 label 当 key 会让 pill 每次状态变化都重建一次 ——
        // 里面那层 key={label} 的淡入反而被整块重挂载吞掉
        <AgentStatus key={index} state={step.state} label={step.label} elapsed={step.elapsed} />
      ))}
    </div>
  );
}
