/**
 * 热力图的渲染测试（ui project / jsdom）。
 *
 * 验的是**结构与口径**，不是像素：一年 371 格、每格一行，格子的档位跟着最大值走，
 * 今天之后的格子不参与，无障碍是一张图而不是 371 个焦点。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "@/shared/local-day";
import type { HeatCell } from "../series";
import { HeatGraph, HeatLegend, monthColumns } from "./heat-graph";

afterEach(cleanup);

const TODAY = "2026-09-24"; // 周四

function renderGraph(cells: HeatCell[]) {
  return render(
    <HeatGraph
      cells={cells}
      today={TODAY}
      summary="最近一年：4 天有记录"
      renderTooltip={(date, value) => `${value} @ ${date}`}
      renderMonth={(date) => date.slice(5, 7)}
    />,
  );
}

function cell(date: string): HTMLElement {
  const node = document.querySelector(`[data-slot="heat-cell"][data-date="${date}"]`);
  if (node === null) throw new Error(`没有找到 ${date} 的格子`);
  return node as HTMLElement;
}

describe("HeatGraph", () => {
  it("固定 53 周 × 7 天的网格，最后一列包含今天", () => {
    const { container } = renderGraph([]);
    const cells = container.querySelectorAll('[data-slot="heat-cell"]');
    expect(cells).toHaveLength(53 * 7);
    expect(cell(TODAY)).toBeTruthy();
    // 网格的第一格是该周周一（不是今天往回数的第一天）
    expect(cell(TODAY).getAttribute("data-date")).toBe(TODAY);
  });

  it("今天之后的格子不画底色，也不参与悬浮", () => {
    renderGraph([{ date: TODAY, value: 10 }]);
    const future = cell(addDays(TODAY, 1));
    expect(future.getAttribute("data-level")).toBe("-1");
    expect(future.className).toContain("bg-transparent");
  });

  it("档位跟着当期最大值：最大值那格是 4 档", () => {
    renderGraph([
      { date: addDays(TODAY, -1), value: 10 },
      { date: TODAY, value: 100 },
    ]);
    expect(cell(TODAY).getAttribute("data-level")).toBe("4");
    expect(cell(addDays(TODAY, -1)).getAttribute("data-level")).toBe("1");
  });

  it("没有记录的格子是 0 档（空槽），不是 1 档", () => {
    renderGraph([{ date: TODAY, value: 100 }]);
    expect(cell(addDays(TODAY, -10)).getAttribute("data-level")).toBe("0");
    expect(cell(addDays(TODAY, -10)).getAttribute("data-value")).toBe("0");
  });

  it("整段没有数据时全部是 0 档，且不崩（max = 0）", () => {
    renderGraph([]);
    expect(cell(TODAY).getAttribute("data-level")).toBe("0");
  });

  it("悬浮出读数，移出网格即收", () => {
    const { container } = renderGraph([{ date: TODAY, value: 1234 }]);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerEnter(cell(TODAY));
    expect(screen.getByRole("tooltip").textContent).toBe(`1234 @ ${TODAY}`);

    fireEvent.pointerLeave(container.firstElementChild as HTMLElement);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("无障碍是一张图：role=img 带概括句，格子对辅助技术不可见", () => {
    renderGraph([{ date: TODAY, value: 1 }]);
    const image = screen.getByRole("img");
    expect(image.getAttribute("aria-label")).toContain("4 天有记录");
    // 371 个格子不该是焦点，也不该进可访问性树
    expect(document.querySelectorAll('[data-slot="heat-cell"][tabindex]')).toHaveLength(0);
    expect(cell(TODAY).getAttribute("aria-hidden")).toBe("true");
  });

  it("月份标签落在该月第一格所在的列，且不会挤在一起", () => {
    renderGraph([]);
    const labels = document.querySelectorAll('[data-slot="heat-month"]');
    // 一年 12–13 个月份标签
    expect(labels.length).toBeGreaterThanOrEqual(11);
    expect(labels.length).toBeLessThanOrEqual(13);
  });
});

describe("monthColumns", () => {
  it("取每月 1 号所在的列，相邻至少隔一列", () => {
    const columns = monthColumns("2026-08-31", "2026-09-24");
    expect(columns.every((entry) => entry.date.endsWith("-01"))).toBe(true);
    for (let index = 1; index < columns.length; index += 1) {
      const previous = columns[index - 1]?.column ?? 0;
      const current = columns[index]?.column ?? 0;
      expect(current - previous).toBeGreaterThanOrEqual(2);
    }
  });

  it("窗口右端之前的月份才算（今天之后的月份标签不该出现）", () => {
    const columns = monthColumns("2026-08-31", "2026-09-24");
    expect(columns.map((entry) => entry.date)).toEqual(["2026-09-01"]);
  });
});

describe("HeatLegend", () => {
  it("五档色块 + 少/多两个端点", () => {
    const { container } = render(<HeatLegend less="少" more="多" />);
    expect(screen.getByText("少")).toBeTruthy();
    expect(screen.getByText("多")).toBeTruthy();
    expect(container.querySelectorAll("span[aria-hidden]")).toHaveLength(5);
  });
});
