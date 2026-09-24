"use client";

/**
 * 每日 Token 趋势图：每个模型一条平滑折线，缺数据的日子按 0。
 *
 * ## 尺寸怎么来
 *
 * 用**真实像素**画（容器宽度由 ResizeObserver 量出来），而不是固定 viewBox 拉伸：
 * 拉伸（`preserveAspectRatio="none"`）会把坐标轴上的字也一起拉变形，而这是张带刻度的图。
 * 量不到宽度时（jsdom、首帧）回落到一个固定宽度，图仍然画得出来。
 *
 * ## 曲线为什么不是简单的三点样条
 *
 * 用 Fritsch–Carlson 的**单调三次插值**：普通 Catmull-Rom 在「0 → 大数 → 0」这种数据上
 * 会冲出负值再冒回来，于是图上出现一段「token 为负」的弧线 —— 那是在撒谎。
 * 单调插值保证局部的升降方向不被插值本身改掉。
 */
import { useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/renderer/lib/utils";
import { seriesColorAt } from "../series";

export interface TrendSeriesInput {
  key: string;
  /** 图例/悬浮里显示的名字 */
  label: string;
  /** 与 dates 一一对应的值（缺数据的日期是 0） */
  points: readonly number[];
  colorIndex: number;
}

export interface TokenTrendChartProps {
  /** 横轴日期（本地日，升序且连续） */
  dates: readonly string[];
  series: readonly TrendSeriesInput[];
  /** 纵轴与悬浮里的读数（按语言格式化） */
  renderValue: (value: number) => string;
  /** 横轴与悬浮里的日期（按语言格式化） */
  renderDate: (date: string) => string;
  /** 全部为 0 时显示的空态文案 */
  emptyLabel: string;
  className?: string;
}

/** 高度固定：宽度自适应，高度跟着变会让图在窗口缩放时忽胖忽瘦 */
const HEIGHT = 208;
const MARGIN = { top: 14, right: 12, bottom: 26, left: 58 };
/** 量不到容器宽度时（首帧 / jsdom）先用它画：数字稳定，测试也不必等布局 */
const FALLBACK_WIDTH = 760;
const MIN_PLOT_WIDTH = 240;
/** 横轴最多标几个日期：再多就成一排糊字了 */
const MAX_X_LABELS = 8;

export function TokenTrendChart({
  dates,
  series,
  renderValue,
  renderDate,
  emptyLabel,
  className,
}: TokenTrendChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = wrapperRef.current;
    if (target === null) return undefined;
    const measure = () => setWidth(target.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const totalWidth = width > 0 ? width : FALLBACK_WIDTH;
  const plotWidth = Math.max(MIN_PLOT_WIDTH, totalWidth - MARGIN.left - MARGIN.right);
  const plotHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const peak = series.reduce(
    (best, entry) => entry.points.reduce((inner, value) => Math.max(inner, value), best),
    0,
  );
  const hasData = peak > 0;

  const scale = niceScale(peak);
  const stepX = dates.length > 1 ? plotWidth / (dates.length - 1) : 0;
  const x = (index: number) => MARGIN.left + index * stepX;
  const y = (value: number) => MARGIN.top + plotHeight * (1 - value / scale.max);

  /** 悬浮：指针横坐标 → 最近的那一天 */
  const onPointerMove = (event: React.PointerEvent<SVGRectElement>) => {
    if (dates.length === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left + MARGIN.left;
    const index =
      stepX === 0
        ? 0
        : Math.min(dates.length - 1, Math.max(0, Math.round((offset - MARGIN.left) / stepX)));
    setHoverIndex(index);
  };

  // 悬浮日期只认「真的有 hovering 且那一下标存在」；两者缺一为 null（浮层据此不渲染）
  const hoveredDate = hoverIndex === null ? null : (dates[hoverIndex] ?? null);
  const xLabels = pickLabels(dates);

  return (
    <div ref={wrapperRef} className={cn("relative w-full", className)}>
      <svg
        width={totalWidth}
        height={HEIGHT}
        role="img"
        aria-label={hasData ? undefined : emptyLabel}
        className="block"
      >
        {/* 横向网格 + 纵轴读数 */}
        {scale.ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
              className="stroke-border"
              strokeWidth={1}
              strokeDasharray={tick === 0 ? undefined : "3 4"}
            />
            <text
              x={MARGIN.left - 8}
              y={y(tick) + 3}
              textAnchor="end"
              className="fill-ink-4 text-[10px]"
            >
              {renderValue(tick)}
            </text>
          </g>
        ))}

        {/* 横轴日期。
            首尾两个标签贴边对齐（而不是居中）：居中的话最后一天的日期会有一半
            落在绘图区之外、被视口裁掉 —— 而它正是用户最关心的那一天。 */}
        {xLabels.map((index, position) => (
          <text
            key={dates[index] ?? index}
            x={x(index)}
            y={HEIGHT - 8}
            textAnchor={
              position === 0 ? "start" : position === xLabels.length - 1 ? "end" : "middle"
            }
            className="fill-ink-4 text-[10px]"
          >
            {renderDate(dates[index] as string)}
          </text>
        ))}

        {/* 悬浮竖线：先画线，再画点，最后数据线盖在上面 */}
        {hoverIndex !== null && (
          <line
            x1={x(hoverIndex)}
            x2={x(hoverIndex)}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
            className="stroke-foreground/25"
            strokeWidth={1}
          />
        )}

        {hasData &&
          series.map((entry) => (
            <path
              key={entry.key}
              data-slot="trend-line"
              data-model={entry.key}
              d={monotoneCubicPath(
                entry.points.map((value, index) => [x(index), y(value)] as const),
              )}
              fill="none"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={seriesColorAt(entry.colorIndex).stroke}
            />
          ))}

        {hoverIndex !== null &&
          hasData &&
          series.map((entry) => (
            <circle
              key={entry.key}
              cx={x(hoverIndex)}
              cy={y(entry.points[hoverIndex] ?? 0)}
              r={2.5}
              className={seriesColorAt(entry.colorIndex).fill}
            />
          ))}

        {/* 悬浮捕获层：盖住绘图区，拿到整片区域上的指针位置 */}
        <rect
          x={MARGIN.left}
          y={MARGIN.top}
          width={plotWidth}
          height={plotHeight}
          fill="transparent"
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIndex(null)}
        />
      </svg>

      {hoveredDate !== null && hasData && (
        <div
          role="tooltip"
          data-slot="trend-tooltip"
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 min-w-40 rounded-md border border-border/60 px-2.5 py-2 text-[11px] shadow-md"
          style={{
            left: clamp(x(hoverIndex ?? 0) + 12, 0, Math.max(0, totalWidth - 190)),
            top: MARGIN.top,
          }}
        >
          <div className="text-ink-3 mb-1.5">{renderDate(hoveredDate)}</div>
          <div className="flex flex-col gap-1">
            {series
              .map((entry) => ({ entry, value: entry.points[hoverIndex ?? 0] ?? 0 }))
              .sort((left, right) => right.value - left.value)
              .map(({ entry, value }) => (
                <div key={entry.key} className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      seriesColorAt(entry.colorIndex).dot,
                    )}
                  />
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  <span className="tabular-nums">{renderValue(value)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 纵轴的「整齐」刻度：取 4 段，步长落在 1/2/2.5/5/10 × 10^n 上。
 * 直接用 max/4 会给出 3.7 亿这种读数，看完不知道坐标轴到底到哪。
 */
export function niceScale(
  max: number,
  segments = 4,
): { max: number; step: number; ticks: number[] } {
  if (!Number.isFinite(max) || max <= 0) {
    return { max: 1, step: 1 / segments, ticks: range(0, 1, segments) };
  }
  const rough = max / segments;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((value) => value >= rough) ??
    10 * magnitude;
  const top = step * segments;
  return { max: top, step, ticks: range(0, top, segments) };
}

function range(from: number, to: number, segments: number): number[] {
  return Array.from(
    { length: segments + 1 },
    (_, index) => from + ((to - from) * index) / segments,
  );
}

/** 横轴抽稀：最多 MAX_X_LABELS 个，且首尾一定在内 */
export function pickLabels(dates: readonly string[], max = MAX_X_LABELS): number[] {
  const count = dates.length;
  if (count === 0) return [];
  if (count <= max) return dates.map((_, index) => index);
  const stride = Math.ceil((count - 1) / (max - 1));
  const out: number[] = [];
  for (let index = 0; index < count; index += stride) out.push(index);
  // 末端补一个：否则最后一段永远没有读数（而用户最关心的就是最近几天）
  if (out[out.length - 1] !== count - 1) out.push(count - 1);
  return out;
}

/**
 * 单调三次插值的 SVG 路径（Fritsch–Carlson）。
 *
 * 只有两三个点时退化成直线；没有任何点时给空串（`d=""` 不画东西，是合法值）。
 * `points` 必须按 x 升序，x 不能重复。
 */
export function monotoneCubicPath(points: readonly (readonly [number, number])[]): string {
  const count = points.length;
  if (count === 0) return "";
  const first = points[0] as readonly [number, number];
  if (count === 1) return `M ${round(first[0])} ${round(first[1])}`;
  if (count === 2) {
    const last = points[1] as readonly [number, number];
    return `M ${round(first[0])} ${round(first[1])} L ${round(last[0])} ${round(last[1])}`;
  }

  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const secants: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (xs[index + 1] as number) - (xs[index] as number);
    secants.push(dx === 0 ? 0 : ((ys[index + 1] as number) - (ys[index] as number)) / dx);
  }

  const tangents = new Array<number>(count).fill(0);
  tangents[0] = secants[0] as number;
  tangents[count - 1] = secants[count - 2] as number;
  for (let index = 1; index < count - 1; index += 1) {
    const before = secants[index - 1] as number;
    const after = secants[index] as number;
    // 极值点（两侧斜率反号）必须把切线压平，否则曲线会冲过头
    tangents[index] = before * after <= 0 ? 0 : (before + after) / 2;
  }
  for (let index = 0; index < count - 1; index += 1) {
    const secant = secants[index] as number;
    if (secant === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const alpha = (tangents[index] as number) / secant;
    const beta = (tangents[index + 1] as number) / secant;
    const magnitude = alpha * alpha + beta * beta;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * alpha * secant;
      tangents[index + 1] = scale * beta * secant;
    }
  }

  let path = `M ${round(first[0])} ${round(first[1])}`;
  for (let index = 0; index < count - 1; index += 1) {
    const x0 = xs[index] as number;
    const x1 = xs[index + 1] as number;
    const y0 = ys[index] as number;
    const y1 = ys[index + 1] as number;
    const dx = (x1 - x0) / 3;
    path +=
      ` C ${round(x0 + dx)} ${round(y0 + (tangents[index] as number) * dx)}` +
      ` ${round(x1 - dx)} ${round(y1 - (tangents[index + 1] as number) * dx)}` +
      ` ${round(x1)} ${round(y1)}`;
  }
  return path;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
