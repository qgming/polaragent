"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";
import type { ContextBreakdown } from "@/shared/contracts";
import { clamp, pct } from "../utils/range";
import { floating, ghostButton, mono } from "./surfaces";

/** 环几何：14px viewBox、2px 描边（与 DSH ContextMeter 同规格） */
const RING_SIZE = 14;
const RING_STROKE = 2;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** 面板里三段的顺序、文案键与色值（色值同时用于条与图例圆点） */
const SEGMENTS = [
  { key: "systemTokens", label: "chat.contextSystem", tint: "bg-foreground/35" },
  { key: "toolsTokens", label: "chat.contextTools", tint: "bg-violet-400" },
  { key: "messageTokens", label: "chat.contextMessages", tint: "bg-blue-500" },
] as const;

/** 紧凑 token 数：1.8K / 82.5K / 1M（保留一位小数，去掉多余的 .0） */
function formatTokens(value: number): string {
  const scaled = (candidate: number) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

export interface ContextMeterProps {
  /** 已用 token（提示侧压力：未缓存输入 + 缓存读取 + 缓存写入） */
  usedTokens: number;
  /** 模型上下文窗口 */
  contextWindow: number;
  /** 三段分解；缺失时只画总占用单段 */
  breakdown?: ContextBreakdown | undefined;
  /** 切会话时重置展开态 */
  resetKey?: string | undefined;
  className?: string;
}

/**
 * 输入框旁的上下文用量环：环 + 百分比读数，点击展开分解面板。
 *
 * 对标 DSH 的 ContextMeter（ui-conversation）：面板头部是「上下文已用 N%」与
 * `~已用 / 窗口` 读数，下面是按系统提示词 / 工具定义 / 对话消息分色的占用条与图例。
 * 没有可用数据（窗口未知或尚未跑过一轮）时整个组件不渲染。
 */
export function ContextMeter({
  usedTokens,
  contextWindow,
  breakdown,
  resetKey,
  className,
}: ContextMeterProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);

  // 切会话时收起面板（旧会话的分解对新会话没有意义）
  useEffect(() => {
    setOpen(false);
  }, [resetKey]);

  // 面板打开时：点外部或按 Escape 关闭
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const hasWindow = Number.isFinite(contextWindow) && contextWindow > 0;
  const percent = hasWindow ? clamp(pct(usedTokens, contextWindow), 0, 100) : 0;
  if (!hasWindow || usedTokens <= 0) return null;

  const breakdownTotal =
    breakdown === undefined
      ? 0
      : breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens;
  // 有分解就按三段各自的占比铺满已用区间；没有就画一整段
  const segments =
    breakdown === undefined || breakdownTotal === 0
      ? [{ key: "total", tint: "bg-foreground/70", width: percent }]
      : SEGMENTS.map((segment) => ({
          key: segment.key,
          tint: segment.tint,
          width: (percent * breakdown[segment.key]) / breakdownTotal,
        })).filter((segment) => segment.width > 0);

  const reading = `${Math.round(percent)}%`;
  const aria = t("chat.contextUsageAria", { percent: Math.round(percent) });

  return (
    <span ref={rootRef} className={cn("relative inline-flex", className)}>
      <button
        type="button"
        data-slot="context-meter-trigger"
        aria-label={aria}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={aria}
        onClick={() => setOpen((value) => !value)}
        className={cn(ghostButton, "size-8")}
      >
        <svg
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          width={16}
          height={16}
          aria-hidden
          className="-rotate-90"
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            className="stroke-foreground/15"
          />
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            strokeWidth={RING_STROKE}
            strokeLinecap="round"
            strokeDasharray={`${(RING_CIRCUMFERENCE * percent) / 100} ${RING_CIRCUMFERENCE}`}
            className="stroke-current transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
          />
        </svg>
      </button>

      {open && (
        <div
          data-slot="context-meter-panel"
          role="dialog"
          aria-label={t("chat.contextUsage")}
          className={cn(
            floating,
            "absolute end-0 bottom-full z-20 mb-2 flex w-72 origin-bottom-right flex-col gap-3 rounded-2xl p-3.5",
          )}
        >
          <div className="flex items-baseline justify-between gap-4 whitespace-nowrap">
            <span className="text-[13px] text-ink-2">
              {t("chat.contextUsage")}
              <span className={cn(mono, "ms-1.5 text-foreground tabular-nums")}>{reading}</span>
            </span>
            <span className={cn(mono, "text-ink-3 tabular-nums")}>
              ~{formatTokens(Math.min(usedTokens, contextWindow))} / {formatTokens(contextWindow)}
            </span>
          </div>

          <div className="bg-foreground/[0.06] flex h-1.5 w-full gap-px overflow-hidden rounded-full">
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={cn(
                  "h-full transition-[width] duration-500 motion-reduce:transition-none",
                  segment.tint,
                )}
                style={{ width: `${segment.width}%` }}
              />
            ))}
          </div>

          {breakdown !== undefined && breakdownTotal > 0 && (
            <dl className="flex flex-col gap-2">
              {SEGMENTS.map((segment) => (
                <div key={segment.key} className="flex items-center gap-2.5 text-[13px] text-ink-2">
                  <span aria-hidden className={cn("size-2 shrink-0 rounded-full", segment.tint)} />
                  <dt className="min-w-0 flex-1 truncate">{t(segment.label)}</dt>
                  <dd className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>
                    ~{formatTokens(breakdown[segment.key])}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}
    </span>
  );
}
