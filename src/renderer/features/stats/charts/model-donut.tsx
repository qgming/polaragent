"use client";

/**
 * 模型用量环图 + 图例。
 *
 * 环图用「虚线周长」画分段（`stroke-dasharray` + 累积 `stroke-dashoffset`），
 * 而不是逐段算 path 弧线：段数少时两者等价，而虚线写法天然支持「分段之间留缝」
 * 与「某段占比极小」这两种情况，不必为 0.4% 的段单独写退化逻辑。
 *
 * 中心显示总量 —— 它同时回答「这些百分比的分母是多少」，比一个空心的环有用。
 */
import { cn } from "@/renderer/lib/utils";
import type { SeriesColor } from "../series";

const SIZE = 176;
const RADIUS = 62;
const THICKNESS = 22;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** 分段之间留的缝（周长单位，约 2px）：没有缝时相邻两段的颜色会黏在一起 */
const GAP_LENGTH = 2;

export interface DonutSlice {
  key: string;
  label: string;
  tokens: number;
  /** 0–1 */
  share: number;
  colorIndex: number;
}

export interface ModelUsageDonutProps {
  slices: readonly DonutSlice[];
  /** 环心的总量读数（已格式化） */
  totalLabel: string;
  /** 环心的单位文案（如「tokens」） */
  totalCaption: string;
  /** 图例里那一行小字（已格式化的 token 读数 + 单位） */
  renderTokens: (tokens: number) => string;
  /** 百分比读数 */
  renderShare: (share: number) => string;
  /** 概括句（无障碍） */
  summary: string;
  className?: string;
  /** 该模型这一槽的配色（与折线图共用同一套数据色板） */
  colorOf: (colorIndex: number) => SeriesColor;
}

export function ModelUsageDonut({
  slices,
  totalLabel,
  totalCaption,
  renderTokens,
  renderShare,
  summary,
  className,
  colorOf,
}: ModelUsageDonutProps) {
  let offset = 0;
  const drawn = slices.map((slice) => {
    const length = CIRCUMFERENCE * clamp01(slice.share);
    // 极小的段也要看得见：至少留出缝宽，否则它会退化成一条看不见的线
    const segment = Math.max(0.5, length - GAP_LENGTH);
    const entry = { slice, segment, offset };
    offset += length;
    return entry;
  });

  return (
    <div className={cn("flex flex-wrap items-center gap-6", className)}>
      <svg
        role="img"
        aria-label={summary}
        width={SIZE}
        height={SIZE}
        className="shrink-0"
        data-slot="model-donut"
      >
        {/* 轨道：没有用量时也能看出「这里是个环」 */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={THICKNESS}
          className="stroke-foreground/[0.06] dark:stroke-foreground/[0.09]"
        />
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {drawn.map(({ slice, segment, offset: start }) => (
            <circle
              key={slice.key}
              data-slot="donut-segment"
              data-model={slice.key}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={THICKNESS}
              strokeDasharray={`${segment} ${CIRCUMFERENCE - segment}`}
              strokeDashoffset={-start}
              className={colorOf(slice.colorIndex).stroke}
            />
          ))}
        </g>
        <text
          x={SIZE / 2}
          y={SIZE / 2 - 2}
          textAnchor="middle"
          className="fill-foreground text-[19px] font-medium tabular-nums"
        >
          {totalLabel}
        </text>
        <text x={SIZE / 2} y={SIZE / 2 + 16} textAnchor="middle" className="fill-ink-4 text-[11px]">
          {totalCaption}
        </text>
      </svg>

      <ul className="min-w-0 flex-1" data-slot="model-legend">
        {slices.map((slice) => (
          <li
            key={slice.key}
            data-slot="model-legend-row"
            data-model={slice.key}
            className="flex flex-col gap-1 border-border/50 py-2.5 not-first:border-t"
          >
            <div className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className={cn("size-2.5 shrink-0 rounded-full", colorOf(slice.colorIndex).dot)}
              />
              {/* 模型名可能很长（带服务前缀的 id）：截断而不是换行，保证右侧占比始终对齐 */}
              <span className="min-w-0 flex-1 truncate text-[13px]" title={slice.label}>
                {slice.label}
              </span>
              <span className="text-ink-2 shrink-0 text-[13px] tabular-nums">
                {renderShare(slice.share)}
              </span>
            </div>
            <div className="text-ink-4 ps-[18px] text-[11px] tabular-nums">
              {renderTokens(slice.tokens)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
