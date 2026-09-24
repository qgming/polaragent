"use client";

/**
 * 用量热力图：一格一天、一列一周的年度日历（对照 assistant-ui 的 heat-graph 元素，
 * 按本仓的数据色与无障碍口径重写）。
 *
 * 与那个元素一致的地方：窗口固定是**最近一年**（到今天为止，往前对齐到周一），
 * 越界的点静默忽略；五个色阶；格子上悬浮给读数。
 *
 * 刻意不同的三处：
 *
 * 1. **无障碍走「一张图」而不是几百个 focusable 格子**。一年 371 格，做成按钮就是
 *    371 个 Tab 停靠点，键盘用户会被困在热力图里；这里整个图是 `role="img"` 加一句
 *    概括（共多少 token、多少天有记录、覆盖哪一段），格子对辅助技术不可见。
 * 2. **色阶跟着数据里的最大值走**，不写死阈值（理由见 series.ts 的 heatLevel）。
 * 3. **不画星期标签、不内置文案**：读数与月份标签都由调用方按自己的语言给
 *    （本组件在中英文下都只是坐标与色块）。
 */
import { useState } from "react";
import { cn } from "@/renderer/lib/utils";
import { addDays, dayKeyToDate } from "@/shared/local-day";
import { type HeatCell, heatLevel } from "../series";

/** 一格的边长与间距：53 列 × 14px = 742px，恰好落在模态窗内容宽度里 */
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
/** 最近一年 = 53 周（含今天所在的那一周） */
const WEEKS = 53;
const DAY_ROWS = 7;

/** 五档底色：0 档是空槽，其余四档按数据色叠加透明度递进 */
export const HEAT_LEVEL_CLASSES: readonly string[] = [
  "bg-foreground/[0.05] dark:bg-foreground/[0.08]",
  "bg-chart-1/25",
  "bg-chart-1/45",
  "bg-chart-1/70",
  "bg-chart-1",
];

export interface HeatGraphProps {
  /** 全部有记录的日期（窗口外的会被忽略） */
  cells: readonly HeatCell[];
  /** 今天（本地日）：窗口的右端锚点 */
  today: string;
  /** 概括句（`role="img"` 的 aria-label），由调用方按语言给 */
  summary: string;
  /** 悬浮读数：给日期与数值，返回显示文本 */
  renderTooltip: (date: string, value: number) => string;
  /** 月份标签文本：给该月 1 号的日期键，返回「10月」/「Oct」 */
  renderMonth: (date: string) => string;
  className?: string;
}

interface HoverState {
  date: string;
  value: number;
  /** 相对网格左上角的像素位置（浮层用绝对定位，不必测量 DOM） */
  x: number;
  y: number;
}

export function HeatGraph({
  cells,
  today,
  summary,
  renderTooltip,
  renderMonth,
  className,
}: HeatGraphProps) {
  const [hover, setHover] = useState<HoverState | null>(null);

  const values = new Map(cells.map((cell) => [cell.date, cell.value]));
  const max = cells.reduce((best, cell) => Math.max(best, cell.value), 0);
  /*
    窗口左端：**今天所在周的周一**再往前数 52 周。
    不能写成「今天减 370 天再对齐周一」—— 那样对齐会把最后不足一周的几天丢掉，
    于是今天的格子根本不在网格里（实测：今天是周四的话，窗口只到最后那个周日之前的那个周一）。
  */
  const start = addDays(mondayOf(today), -(WEEKS - 1) * DAY_ROWS);

  return (
    <div className={cn("relative w-max", className)} onPointerLeave={() => setHover(null)}>
      <div role="img" aria-label={summary} className="flex flex-col">
        <div className="flex" style={{ gap: GAP }}>
          {Array.from({ length: WEEKS }, (_, column) => (
            // key 用那一列的第一天：格子每天都在变（today 会前进），下标当 key 会错位复用
            <div
              key={addDays(start, column * DAY_ROWS)}
              className="flex flex-col"
              style={{ gap: GAP }}
            >
              {Array.from({ length: DAY_ROWS }, (_, row) => {
                const date = addDays(start, column * DAY_ROWS + row);
                const future = date > today;
                const value = values.get(date) ?? 0;
                // -1 = 今天之后的那几格：不画底色，也不参与悬浮
                const level = future ? -1 : heatLevel(value, max);
                return (
                  <div
                    key={date}
                    aria-hidden="true"
                    data-slot="heat-cell"
                    data-date={date}
                    data-value={value}
                    data-level={level}
                    className={cn(
                      "rounded-[3px]",
                      level < 0 ? "bg-transparent" : HEAT_LEVEL_CLASSES[level],
                    )}
                    style={{ width: CELL, height: CELL }}
                    onPointerEnter={
                      future
                        ? undefined
                        : () => setHover({ date, value, x: column * STEP, y: row * STEP })
                    }
                  />
                );
              })}
            </div>
          ))}
        </div>

        {/* 月份标签：落在该月第一格所在的列；相邻太近就不画（否则「10月11月」糊成一片）。
            行高要给足：这一行是绝对定位标签的容器，而外层是横向滚动容器 ——
            标签的行盒一旦超出容器高度，浏览器会**同时**冒出一条竖向滚动条
            （overflow-x: auto 会把 overflow-y 的取值也变成 auto，实测多出 3px 就够）。 */}
        <div className="relative mt-1 h-4">
          {monthColumns(start, today).map((entry) => (
            <span
              key={entry.date}
              aria-hidden="true"
              data-slot="heat-month"
              className="text-ink-4 absolute top-0 text-[10px] leading-none"
              style={{ left: entry.column * STEP }}
            >
              {renderMonth(entry.date)}
            </span>
          ))}
        </div>
      </div>

      {hover !== null && (
        <div
          role="tooltip"
          data-slot="heat-tooltip"
          className="bg-popover text-popover-foreground pointer-events-none absolute z-10 rounded-md border border-border/60 px-2 py-1 text-[11px] whitespace-nowrap shadow-md"
          style={{ left: hover.x + 20, top: Math.max(0, hover.y - 28) }}
        >
          {renderTooltip(hover.date, hover.value)}
        </div>
      )}
    </div>
  );
}

/** 色阶图例：少 → 多 */
export function HeatLegend({ less, more }: { less: string; more: string }) {
  return (
    <div className="text-ink-4 flex items-center gap-1.5 text-[10px]">
      <span>{less}</span>
      {HEAT_LEVEL_CLASSES.map((className) => (
        <span
          key={className}
          aria-hidden="true"
          className={cn("rounded-[3px]", className)}
          style={{ width: CELL, height: CELL }}
        />
      ))}
      <span>{more}</span>
    </div>
  );
}

/** 该日期所在周的周一 */
function mondayOf(date: string): string {
  // getDay() 的 0 是周日，换算成「距周一几天」
  const offset = (dayKeyToDate(date).getDay() + 6) % 7;
  return addDays(date, -offset);
}

/**
 * 月份标签的列位：每个月 1 号那一格所在的列。
 *
 * 需要至少隔一列才画下一个标签 —— 一个月只有 4–5 列，两个月挨着时两个标签会重叠。
 * 窗口左端不是 1 号时，第一个标签略过（它代表的月份已经有半个在窗口外了）。
 */
export function monthColumns(
  start: string,
  today: string,
  weeks = WEEKS,
): { date: string; column: number }[] {
  const out: { date: string; column: number }[] = [];
  let lastColumn = -3;
  for (let offset = 0; offset < weeks * DAY_ROWS; offset += 1) {
    const date = addDays(start, offset);
    if (date > today) break;
    // 日期键固定是 YYYY-MM-DD：末两位为 "01" 即该月第一天
    if (!date.endsWith("-01")) continue;
    const column = Math.floor(offset / DAY_ROWS);
    if (column - lastColumn < 2) continue;
    lastColumn = column;
    out.push({ date, column });
  }
  return out;
}
