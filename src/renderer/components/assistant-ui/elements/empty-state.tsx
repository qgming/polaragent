"use client";

import { ArrowUpIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { inkButton, paper } from "./surfaces";

export function EmptyState({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state"
      className={cn("flex w-full max-w-md flex-col items-center gap-7", className)}
      {...props}
    />
  );
}

export function EmptyStateGreeting({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      data-slot="empty-state-greeting"
      className={cn(
        "fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-center text-2xl font-medium tracking-tight duration-500 motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyStateSuggestions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="empty-state-suggestions"
      // role=group：这一排是一组并列的起手式，读屏时会先报出组的名字再逐条读
      role="group"
      className={cn("flex flex-wrap items-center justify-center gap-2", className)}
      {...props}
    />
  );
}

/**
 * 一枚起手提示 chip：图标 + 短标签，等宽胶囊。
 *
 * 高度与 composer 里那排 chip 对齐（h-8），因为它俩在空会话页上只隔一个输入框 ——
 * 高度差一档就会看出来是两套控件。图标由调用方给（每条提示自己的字形）。
 */
export function EmptyStateSuggestion({
  index = 0,
  className,
  style,
  ...props
}: ComponentProps<"button"> & { index?: number }) {
  return (
    <button
      type="button"
      data-slot="empty-state-suggestion"
      style={{ animationDelay: `${120 + index * 70}ms`, ...style }}
      className={cn(
        paper,
        "fade-in slide-in-from-bottom-2 animate-in fill-mode-both text-ink-2 hover:text-foreground focus-visible:ring-foreground/20 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] transition-[transform,color] duration-500 outline-none hover:-translate-y-px focus-visible:ring-1 active:scale-[0.96] motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyStateComposer({
  placeholder,
  onSend,
  className,
  style,
  ...props
}: Omit<ComponentProps<"div">, "children" | "placeholder"> & {
  placeholder: string;
  onSend?: () => void;
}) {
  return (
    <div
      data-slot="empty-state-composer"
      style={{ animationDelay: "360ms", ...style }}
      className={cn(
        paper,
        "fade-in slide-in-from-bottom-2 animate-in fill-mode-both flex h-13 w-full items-center justify-between rounded-full py-2 ps-5 pe-2.5 duration-500 motion-reduce:animate-none",
        className,
      )}
      {...props}
    >
      <span className="text-ink-4 text-[15px]">{placeholder}</span>
      <button
        type="button"
        aria-label="Send"
        onClick={onSend}
        disabled={!onSend}
        className={cn(
          inkButton,
          "flex size-8 items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-30",
        )}
      >
        <ArrowUpIcon className="size-4" />
      </button>
    </div>
  );
}
