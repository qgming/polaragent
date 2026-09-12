"use client";

import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { mono, ShimmerLabel } from "./surfaces";

export function ThinkingIndicator({
  label,
  elapsed,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "label" | "elapsed"> & {
  label: string;
  elapsed?: string;
}) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn("text-ink-3 flex items-center gap-2.5 text-sm", className)}
      {...props}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-blue-500 motion-reduce:animate-none dark:bg-blue-400"
      />
      {/*
        进入动画与 shimmer 必须落在**两层**元素上。

        `animation` 是简写属性，同一个元素上的两条声明会互相整条覆盖 —— 上游把
        `shimmer` 与 `animate-in` 放在一个 span 上，而产物里 `.animate-in` 在 `.shimmer`
        之后，于是 shimmer 的 `animation` 被吃掉，扫光从来没有播放过。
        拆成两层后两者各管各的：外层负责入场，内层负责扫光。
      */}
      <span
        key={label}
        className="fade-in slide-in-from-bottom-1 animate-in relative inline-block leading-none duration-300"
      >
        <ShimmerLabel>{label}</ShimmerLabel>
      </span>
      {elapsed !== undefined && (
        <span className={cn(mono, "text-ink-4 tabular-nums")}>{elapsed}</span>
      )}
    </div>
  );
}
