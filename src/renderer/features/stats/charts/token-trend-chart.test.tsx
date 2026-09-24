/**
 * 趋势图的渲染与曲线数学（ui project / jsdom）。
 *
 * 重点验两件事：
 *   1. **曲线不撒谎** —— 单调三次插值在「0 → 大数 → 0」这种数据上不能冲出负值；
 *   2. **空数据要有明确空态** —— 这段时间没有记录时不该画一条贴着 0 的假线。
 * 容器宽度在 jsdom 里量不到（getBoundingClientRect 恒为 0），走的是回落的固定宽度，
 * 所以坐标断言是稳定的。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  monotoneCubicPath,
  niceScale,
  pickLabels,
  TokenTrendChart,
  type TrendSeriesInput,
} from "./token-trend-chart";

afterEach(cleanup);

const DATES = ["2026-09-22", "2026-09-23", "2026-09-24"];

function series(overrides: Partial<TrendSeriesInput> = {}): TrendSeriesInput {
  return { key: "svc|m1", label: "m1", points: [1, 5, 2], colorIndex: 0, ...overrides };
}

function renderChart(input: { dates?: string[]; series?: TrendSeriesInput[] } = {}) {
  return render(
    <TokenTrendChart
      dates={input.dates ?? DATES}
      series={input.series ?? [series()]}
      renderValue={(value) => `${value}t`}
      renderDate={(date) => date.slice(5)}
      emptyLabel="没有数据"
    />,
  );
}

describe("TokenTrendChart", () => {
  it("每个模型一条线，坐标轴上是那几天的日期", () => {
    const { container } = renderChart({
      series: [series(), series({ key: "svc|m2", label: "m2", points: [0, 3, 3], colorIndex: 1 })],
    });
    const lines = container.querySelectorAll('[data-slot="trend-line"]');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute("data-model")).toBe("svc|m1");
    expect(screen.getByText("09-24")).toBeTruthy();
  });

  it("纵轴刻度是整齐的步长（不是 max/4 那种奇怪数字）", () => {
    const { container } = renderChart();
    // 峰值 5 -> 步长 2 的 4 段（0/2/4/6/8）
    const ticks = [...container.querySelectorAll("text")].map((node) => node.textContent);
    expect(ticks).toContain("0t");
    expect(ticks).toContain("8t");
  });

  it("全部为 0 时进空态：不画线，只留空态文案", () => {
    const { container } = renderChart({
      series: [series({ points: [0, 0, 0] })],
    });
    expect(container.querySelectorAll('[data-slot="trend-line"]')).toHaveLength(0);
    expect(screen.getByLabelText("没有数据")).toBeTruthy();
  });

  it("悬浮到绘图区会显示那一天的读数（含各模型）", () => {
    const { container } = renderChart({
      series: [series(), series({ key: "svc|m2", label: "m2", points: [0, 3, 3], colorIndex: 1 })],
    });
    const capture = container.querySelector("rect[fill='transparent']");
    expect(capture).toBeTruthy();
    if (capture === null) return;

    // 指针落在最左端 -> 第一天
    capture.getBoundingClientRect = () => ({ left: 0, top: 0, width: 700, height: 160 }) as DOMRect;
    fireEvent.pointerMove(capture, { clientX: 58, clientY: 40 });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("09-22");
    expect(tooltip.textContent).toContain("m1");
    expect(tooltip.textContent).toContain("1t");

    fireEvent.pointerLeave(capture);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("单点数据也能画（只有一天记录时不崩）", () => {
    const { container } = renderChart({ dates: ["2026-09-24"], series: [series({ points: [7] })] });
    const line = container.querySelector('[data-slot="trend-line"]');
    expect(line?.getAttribute("d")).toMatch(/^M /);
    expect(line?.getAttribute("d")).not.toContain("C");
  });
});

describe("niceScale", () => {
  it("落在 1/2/2.5/5/10 × 10^n 上，并且覆盖峰值", () => {
    expect(niceScale(5)).toEqual({ max: 8, step: 2, ticks: [0, 2, 4, 6, 8] });
    expect(niceScale(100).max).toBe(100);
    expect(niceScale(43718442).step).toBe(20_000_000);
    expect(niceScale(43718442).max).toBeGreaterThanOrEqual(43718442);
  });

  it("0 或坏值给一个不除零的刻度", () => {
    expect(niceScale(0).max).toBe(1);
    expect(niceScale(Number.NaN).max).toBe(1);
    expect(niceScale(-3).max).toBe(1);
  });
});

describe("pickLabels", () => {
  it("少于上限时全部标出", () => {
    expect(pickLabels(["a", "b", "c"])).toEqual([0, 1, 2]);
  });

  it("超过上限时抽稀，且首尾一定在内（最近几天必须有读数）", () => {
    const dates = Array.from({ length: 30 }, (_, index) => `d${index}`);
    const picked = pickLabels(dates);
    expect(picked.length).toBeLessThanOrEqual(9);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(29);
  });

  it("空数组给空表", () => {
    expect(pickLabels([])).toEqual([]);
  });
});

describe("monotoneCubicPath", () => {
  it("空点集给空串，单点给一个 M，两点给直线", () => {
    expect(monotoneCubicPath([])).toBe("");
    expect(monotoneCubicPath([[1, 2]])).toBe("M 1 2");
    expect(
      monotoneCubicPath([
        [0, 0],
        [10, 5],
      ]),
    ).toBe("M 0 0 L 10 5");
  });

  it("多点给三次贝塞尔", () => {
    const path = monotoneCubicPath([
      [0, 0],
      [10, 10],
      [20, 20],
    ]);
    expect(path.startsWith("M 0 0")).toBe(true);
    expect(path.match(/C/g)).toHaveLength(2);
  });

  /**
   * 关键的一条：数据在两端归零、中间很高时，曲线**不能冲到 0 以下再冒回来**。
   * 普通 Catmull-Rom 会（图上会出现一段「token 为负」的弧线）。
   */
  it("不在 0 → 大数 → 0 的数据上冲出负值", () => {
    const path = monotoneCubicPath([
      [0, 0],
      [10, 100],
      [20, 0],
      [30, 0],
    ]);
    // 曲线上的所有 y（端点 + 控制点）都不得为负
    for (const point of pathSegments(path).flatMap((segment) => [
      segment.y0,
      segment.c1y,
      segment.c2y,
      segment.y1,
    ])) {
      expect(point).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * 单调性：每段的两个控制点都夹在该段两端点之间。
   *
   * 这是三次贝塞尔单调的**充分条件**，也正是 Fritsch–Carlson 的切线限幅
   * （α² + β² ≤ 9 ⇒ 各 ≤ 3）所保证的东西 —— 检查它就等于检查「曲线没有回摆」，
   * 而不必真的把曲线采样出来。
   */
  it("单调上升的数据不会回摆：控制点夹在该段两端点之间", () => {
    const path = monotoneCubicPath([
      [0, 0],
      [10, 10],
      [20, 30],
      [30, 31],
    ]);
    const segments = pathSegments(path);
    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      const low = Math.min(segment.y0, segment.y1);
      const high = Math.max(segment.y0, segment.y1);
      expect(segment.c1y).toBeGreaterThanOrEqual(low);
      expect(segment.c1y).toBeLessThanOrEqual(high);
      expect(segment.c2y).toBeGreaterThanOrEqual(low);
      expect(segment.c2y).toBeLessThanOrEqual(high);
      // 数据本身单调递增，段的终点不该往回走
      expect(segment.y1).toBeGreaterThanOrEqual(segment.y0);
    }
  });
});

/**
 * 按 SVG 路径的语法取分段：`M x y` 之后每段是 `C x1 y1 x2 y2 x y`。
 * 断言曲线形状只能这样读 —— 不解析路径就只能靠肉眼看图。
 */
function pathSegments(path: string): { y0: number; c1y: number; c2y: number; y1: number }[] {
  const numbers = [...path.matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const segments: { y0: number; c1y: number; c2y: number; y1: number }[] = [];
  let previousY = numbers[1] ?? 0;
  for (let index = 2; index + 5 < numbers.length; index += 6) {
    segments.push({
      y0: previousY,
      c1y: numbers[index + 1] as number,
      c2y: numbers[index + 3] as number,
      y1: numbers[index + 5] as number,
    });
    previousY = numbers[index + 5] as number;
  }
  return segments;
}
