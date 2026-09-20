"use client";

import { DatabaseIcon, GaugeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/renderer/lib/utils";
import type { SessionStats, SessionTokenUsage } from "@/shared/contracts";
import { floating, mono } from "./surfaces";

/**
 * 输入框下方的会话统计条，对标 DSH 的 StatsPills（ui-chat 的 conversation.composer.dock）。
 *
 * 两个胶囊：
 * - 时间胶囊：`N 轮 M 步 · X tok/s`，点击展开「会话统计」（模型用时 / 工具调用用时 /
 *   首 token 平均 / 输出速度）；
 * - 用量胶囊：`X tok · 缓存命中 N%`，点击展开「Token 用量」（未缓存输入 / 缓存读取 /
 *   缓存写入 / 输出）。
 *
 * 两个弹层都是 `position: fixed` 的浮层：统计条处在滚动容器（Thread Viewport 的脚注）里，
 * 用 absolute 会被 overflow 裁掉。
 */

/** 紧凑 token 数：1.1M / 82.5K */
function formatTokens(value: number): string {
  const scaled = (candidate: number) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10);
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${scaled(value / 1_000)}K`;
  return `${scaled(value / 1_000_000)}M`;
}

/** 精确 token 数（带千分位）：72,388 */
function formatExactTokens(value: number): string {
  return value.toLocaleString("en-US");
}

/** tok/s 读数：一位小数，去掉多余的 .0 */
function formatTokensPerSecond(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 紧凑时长：45.2 秒 / 5 分 51 秒 */
function formatDuration(ms: number, t: (key: string, options?: Record<string, unknown>) => string) {
  const seconds = ms / 1_000;
  if (seconds < 60) {
    const value = Math.round(seconds * 10) / 10;
    return t("chat.statsDurationSeconds", { seconds: value });
  }
  const whole = Math.round(seconds);
  return t("chat.statsDurationMinutes", {
    minutes: Math.floor(whole / 60),
    seconds: whole % 60,
  });
}

/** 计费输入总量：三个互斥桶之和（DSH 的 billedInputTokens 同口径） */
function billedInputTokens(usage: SessionTokenUsage): number {
  return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/**
 * 缓存命中率读数。
 *
 * 分母是计费输入总量，分子是缓存读取量。整数百分比取整后到 100 会撒谎
 * （99.6% 显示成 100%），所以那种情况补一位小数。
 */
function cacheHitPercent(usage: SessionTokenUsage): number | null {
  const denominator = billedInputTokens(usage);
  if (denominator <= 0) return null;
  const exact = (usage.cacheReadTokens / denominator) * 100;
  if (exact >= 100) return 100;
  const rounded = Math.round(exact);
  if (rounded >= 100) return Math.round(exact * 10) / 10;
  return rounded;
}

/** 定位浮层：贴在触发元素上方居中，并夹在视口内 */
function useAnchoredPanel() {
  const rootRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (anchor === undefined || panel === undefined) return;
      const margin = 8;
      const left = Math.min(
        Math.max(margin, anchor.left + anchor.width / 2 - panel.width / 2),
        window.innerWidth - panel.width - margin,
      );
      setPos({ left, top: anchor.top - panel.height - margin });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (rootRef.current?.contains(target) === true) return;
      if (panelRef.current?.contains(target) === true) return;
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

  return { open, setOpen, rootRef, panelRef, pos };
}

/** 浮层里的「标题 + 规则线 + 明细行」外壳 */
function StatPanel({
  panelRef,
  pos,
  label,
  icon,
  title,
  value,
  children,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  pos: { left: number; top: number } | null;
  label: string;
  icon: React.ReactNode;
  title: string;
  value?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      style={
        pos === null ? { visibility: "hidden", left: 0, top: 0 } : { left: pos.left, top: pos.top }
      }
      className={cn(floating, "fixed z-50 flex w-64 flex-col gap-2.5 rounded-2xl p-3.5 shadow-lg")}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <span className="text-ink-3 [&_svg]:size-3.5" aria-hidden>
            {icon}
          </span>
          {title}
        </span>
        {value !== undefined && (
          <span className={cn(mono, "text-ink-3 tabular-nums")}>{value}</span>
        )}
      </div>
      <div className="bg-foreground/[0.08] h-px" aria-hidden />
      <dl className="flex flex-col gap-2">{children}</dl>
    </div>
  );
}

/** 明细行：左标签右读数 */
function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-[13px]">
      <dt className="text-ink-2">{label}</dt>
      <dd className={cn(mono, "text-ink-3 tabular-nums")}>{value}</dd>
    </div>
  );
}

/** 胶囊按钮：图标 + 文本，hover / 展开时带底色 */
function Pill({
  children,
  label,
  expanded,
  onClick,
  innerRef,
}: {
  children: React.ReactNode;
  label: string;
  expanded: boolean;
  onClick: () => void;
  innerRef: React.RefObject<HTMLSpanElement | null>;
}) {
  return (
    <span ref={innerRef} className="inline-flex min-w-0">
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={label}
        onClick={onClick}
        className={cn(
          // py-[3px]：胶囊自身的纵向内边距；与底栏的 3px 一起构成状态条的视觉呼吸
          "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-[3px] text-[13px] leading-none tabular-nums",
          "text-ink-3 transition-colors hover:bg-foreground/[0.06] hover:text-ink-2 dark:hover:bg-foreground/[0.09]",
          "focus-visible:ring-1 focus-visible:ring-foreground/20 focus-visible:outline-none motion-reduce:transition-none",
          expanded && "bg-foreground/[0.06] text-ink-2 dark:bg-foreground/[0.09]",
        )}
      >
        {children}
      </button>
    </span>
  );
}

/** 分隔点 */
function Sep() {
  return (
    <span aria-hidden className="text-ink-4 mx-1.5">
      ·
    </span>
  );
}

function TimePill({
  stats,
  t,
}: {
  stats: SessionStats;
  t: (key: string, o?: Record<string, unknown>) => string;
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useAnchoredPanel();

  const counts = t("chat.statsCounts", { turns: stats.turns, steps: stats.steps });
  const tps =
    stats.decodeMs > 0
      ? t("chat.tokensPerSecond", {
          tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
        })
      : null;
  const hasTiming =
    stats.llmMs > 0 || stats.toolMs > 0 || stats.ttftSteps > 0 || stats.decodeMs > 0;

  const label = tps === null ? counts : `${counts} · ${tps}`;

  // 没有任何耗时数据（供应商不上报 / 还没跑完一步）时胶囊不可点，只展示计数
  if (!hasTiming) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-[3px] text-[13px] leading-none tabular-nums text-ink-3">
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{counts}</span>
      </span>
    );
  }

  return (
    <>
      <Pill
        label={label}
        expanded={open}
        onClick={() => setOpen((value) => !value)}
        innerRef={rootRef}
      >
        <GaugeIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{counts}</span>
        {tps !== null && (
          <>
            <Sep />
            {tps}
          </>
        )}
      </Pill>
      {open && (
        <StatPanel
          panelRef={panelRef}
          pos={pos}
          label={t("chat.statsTitle")}
          icon={<GaugeIcon />}
          title={t("chat.statsTitle")}
        >
          {stats.llmMs > 0 && (
            <StatRow label={t("chat.statsLlmTime")} value={formatDuration(stats.llmMs, t)} />
          )}
          {stats.toolMs > 0 && (
            <StatRow label={t("chat.statsToolTime")} value={formatDuration(stats.toolMs, t)} />
          )}
          {stats.ttftSteps > 0 && (
            <StatRow
              label={t("chat.statsTtft")}
              value={formatDuration(stats.ttftMs / stats.ttftSteps, t)}
            />
          )}
          {stats.decodeMs > 0 && (
            <StatRow
              label={t("chat.statsSpeed")}
              value={t("chat.tokensPerSecond", {
                tps: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)),
              })}
            />
          )}
        </StatPanel>
      )}
    </>
  );
}

function UsagePill({
  usage,
  t,
}: {
  usage: SessionTokenUsage;
  t: (key: string, o?: Record<string, unknown>) => string;
}) {
  const { open, setOpen, rootRef, panelRef, pos } = useAnchoredPanel();

  const total = billedInputTokens(usage) + usage.outputTokens;
  const totalText = t("chat.statsTokens", { count: formatTokens(total) });
  const hit = cacheHitPercent(usage);
  const hitText = hit === null ? null : t("chat.statsCacheHit", { percent: hit });
  const label = hitText === null ? totalText : `${totalText} · ${hitText}`;

  return (
    <>
      <Pill
        label={label}
        expanded={open}
        onClick={() => setOpen((value) => !value)}
        innerRef={rootRef}
      >
        <DatabaseIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">{totalText}</span>
        {hitText !== null && (
          <>
            <Sep />
            {hitText}
          </>
        )}
      </Pill>
      {open && (
        <StatPanel
          panelRef={panelRef}
          pos={pos}
          label={t("chat.statsUsageTitle")}
          icon={<DatabaseIcon />}
          title={t("chat.statsUsageTitle")}
          value={t("chat.statsTokens", { count: formatExactTokens(total) })}
        >
          {hit !== null && <StatRow label={t("chat.statsCacheHitLabel")} value={`${hit}%`} />}
          <StatRow
            label={t("chat.statsUncachedInput")}
            value={t("chat.statsTokens", { count: formatExactTokens(usage.uncachedInputTokens) })}
          />
          <StatRow
            label={t("chat.statsCacheRead")}
            value={t("chat.statsTokens", { count: formatExactTokens(usage.cacheReadTokens) })}
          />
          {usage.cacheWriteTokens !== 0 && (
            <StatRow
              label={t("chat.statsCacheWrite")}
              value={t("chat.statsTokens", { count: formatExactTokens(usage.cacheWriteTokens) })}
            />
          )}
          <StatRow
            label={t("chat.statsOutput")}
            value={t("chat.statsTokens", { count: formatExactTokens(usage.outputTokens) })}
          />
        </StatPanel>
      )}
    </>
  );
}

export interface StatusBarProps {
  /** 会话级统计：缺失（还没跑过一轮）时不显示时间胶囊 */
  stats?: SessionStats | undefined;
  /** 会话级 Token 用量：缺失或全为 0 时不显示用量胶囊 */
  tokenUsage?: SessionTokenUsage | undefined;
  /** 切会话时收起弹层 */
  resetKey?: string | undefined;
  className?: string;
}

/**
 * 输入框下方的状态条：两个可点开的胶囊，居中排在输入框与窗口底边之间的间距里。
 *
 * **高度恒定**：即使一个数据都没有（空会话 / 供应商不上报用量），也占住同一行高度 ——
 * 否则底栏会随数据有无涨落，输入框与窗口底边的距离跟着跳，用户会看到输入框「弹一下」。
 * 因此这里不返回 null，而是渲染一个等高的空行。
 * 自身不带纵向内边距 —— 上下各 3px 由调用方（Thread 的不透明底栏）给定。
 */
export function StatusBar({ stats, tokenUsage, resetKey, className }: StatusBarProps) {
  const { t } = useTranslation();
  const hasStats = stats !== undefined && stats.steps > 0;
  const hasTokens =
    tokenUsage !== undefined && (billedInputTokens(tokenUsage) > 0 || tokenUsage.outputTokens > 0);

  return (
    <div
      data-slot="composer-stats"
      data-empty={hasStats || hasTokens ? undefined : true}
      // key 挂在内容层：切会话时两个胶囊整体重建，弹层状态随之清零
      key={resetKey ?? "none"}
      className={cn(
        // min-h-5（20px）是胶囊行的固定高度：胶囊 py-[3px] + 13px 行高 ≈ 19px，
        // 取整到 20 保证「有数据」与「没数据」两态完全等高
        "flex min-h-5 w-full items-center justify-center gap-3 px-4 text-[13px] leading-none text-ink-3",
        className,
      )}
      // 空态留白：无障碍上不该被读成一个可交互区域
      aria-hidden={hasStats || hasTokens ? undefined : true}
    >
      {hasStats && <TimePill stats={stats} t={t} />}
      {hasTokens && <UsagePill usage={tokenUsage} t={t} />}
    </div>
  );
}
