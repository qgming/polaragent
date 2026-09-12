"use client";

import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { mono } from "./surfaces";

export interface DatedMessage {
  id: string;
  day: string;
  time: string;
  role: "user" | "assistant";
  text: string;
}

/**
 * 单独一行日期分隔（细线 + 眉题 + 细线）。
 *
 * 抽出来是因为本应用的消息由逐条 primitives 渲染（markdown、工具调用、审批卡），
 * 用不了整段转录那套带气泡的 `DaySeparator`；真正需要复用的只有这一行的视觉。
 * `DaySeparator` 内部也走它，避免两套实现各自漂移。
 */
export function DaySeparatorRow({
  label,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children"> & { label: string }) {
  return (
    <div
      data-slot="day-separator-row"
      className={cn("flex items-center gap-2.5 py-1", className)}
      {...props}
    >
      <span className="bg-foreground/[0.08] h-px flex-1" />
      <span className={cn(mono, "text-ink-4")}>{label}</span>
      <span className="bg-foreground/[0.08] h-px flex-1" />
    </div>
  );
}

export function DaySeparator({
  messages,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "messages"> & {
  messages: readonly DatedMessage[];
}) {
  let lastDay = "";

  return (
    <div
      data-slot="day-separator"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}
      {...props}
    >
      {messages.map((message) => {
        const newDay = message.day !== lastDay;
        lastDay = message.day;

        return (
          <div key={message.id} className="flex flex-col gap-2">
            {newDay && <DaySeparatorRow label={message.day} />}
            <div
              className={cn(
                "group flex items-baseline gap-2",
                message.role === "user" && "flex-row-reverse",
              )}
            >
              <span
                className={cn(
                  "max-w-[80%] text-[13.5px] leading-relaxed break-words",
                  message.role === "user"
                    ? "bg-foreground/[0.05] rounded-2xl px-3.5 py-2"
                    : "text-ink-2",
                )}
              >
                {message.text}
              </span>
              <span
                className={cn(
                  mono,
                  "text-ink-4 group-hover:text-ink-4 shrink-0 tabular-nums transition-colors",
                )}
              >
                {message.time}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
