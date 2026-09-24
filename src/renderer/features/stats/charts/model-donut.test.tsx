/**
 * 模型用量环图的渲染测试（ui project / jsdom）。
 *
 * 环图最容易出的两类错都在这里盯着：**占比与弧长对不上**（段长按错的数值算），
 * 以及**图例与环不同源**（图例列的是另一份数据）。所以断言直接读 SVG 上的
 * `stroke-dasharray`，并与传入的占比对照。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { seriesColorAt } from "../series";
import { type DonutSlice, ModelUsageDonut } from "./model-donut";

afterEach(cleanup);

const SLICES: DonutSlice[] = [
  { key: "svc|a", label: "a", tokens: 800, share: 0.8, colorIndex: 0 },
  { key: "svc|b", label: "b", tokens: 150, share: 0.15, colorIndex: 1 },
  { key: "svc|c", label: "c", tokens: 50, share: 0.05, colorIndex: 2 },
];

function renderDonut(slices: DonutSlice[] = SLICES) {
  return render(
    <ModelUsageDonut
      slices={slices}
      totalLabel="1.2万"
      totalCaption="tokens"
      renderTokens={(tokens) => `${tokens} tokens`}
      renderShare={(share) => `${Math.round(share * 100)}%`}
      summary="各模型的 Token 占比"
      colorOf={seriesColorAt}
    />,
  );
}

/** 读一段的 dasharray 长度（第一段数字） */
function segmentLength(node: Element): number {
  const value = node.getAttribute("stroke-dasharray") ?? "0 0";
  return Number(value.split(" ")[0]);
}

describe("ModelUsageDonut", () => {
  it("每个模型一段弧，弧长与占比同序", () => {
    const { container } = renderDonut();
    const segments = [...container.querySelectorAll('[data-slot="donut-segment"]')];
    expect(segments).toHaveLength(3);
    expect(segments.map((node) => node.getAttribute("data-model"))).toEqual([
      "svc|a",
      "svc|b",
      "svc|c",
    ]);
    const [first, second, third] = segments.map(segmentLength) as [number, number, number];
    expect(first).toBeGreaterThan(second);
    expect(second).toBeGreaterThan(third);
  });

  it("每段用自己那一槽的数据色（图例与弧同色）", () => {
    const { container } = renderDonut();
    const segments = [...container.querySelectorAll('[data-slot="donut-segment"]')];
    expect(segments[0]?.getAttribute("class")).toContain("stroke-chart-1");
    expect(segments[2]?.getAttribute("class")).toContain("stroke-chart-3");
  });

  it("环心是总量与单位", () => {
    renderDonut();
    expect(screen.getByText("1.2万")).toBeTruthy();
    expect(screen.getByText("tokens")).toBeTruthy();
  });

  it("图例逐行给出名字、占比与 token 数", () => {
    const { container } = renderDonut();
    const rows = [...container.querySelectorAll('[data-slot="model-legend-row"]')];
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("a");
    expect(rows[0]?.textContent).toContain("80%");
    expect(rows[0]?.textContent).toContain("800 tokens");
    expect(rows[2]?.textContent).toContain("5%");
  });

  it("占比极小的段也不会消失（至少留出缝宽）", () => {
    renderDonut([
      { key: "svc|a", label: "a", tokens: 999_999, share: 0.9999, colorIndex: 0 },
      { key: "svc|tiny", label: "tiny", tokens: 1, share: 0.0000001, colorIndex: 1 },
    ]);
    const segments = [...document.querySelectorAll('[data-slot="donut-segment"]')];
    expect(segmentLength(segments[1] as Element)).toBeGreaterThan(0);
  });

  it("坏占比（NaN / 超界）被夹住，不产生非法 SVG 属性", () => {
    const { container } = render(
      <ModelUsageDonut
        slices={[
          { key: "svc|a", label: "a", tokens: 1, share: Number.NaN, colorIndex: 0 },
          { key: "svc|b", label: "b", tokens: 1, share: 5, colorIndex: 1 },
        ]}
        totalLabel="1"
        totalCaption="tokens"
        renderTokens={(tokens) => `${tokens}`}
        renderShare={(share) => `${share}`}
        summary="占比"
        colorOf={seriesColorAt}
      />,
    );
    for (const node of container.querySelectorAll('[data-slot="donut-segment"]')) {
      const dasharray = node.getAttribute("stroke-dasharray") ?? "";
      expect(dasharray).not.toContain("NaN");
      for (const value of dasharray.split(" ")) {
        expect(Number(value)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("无障碍：整环一句概括，长名字用 title 兜底", () => {
    render(
      <ModelUsageDonut
        slices={[
          { key: "svc|long", label: "非常非常长的模型名字", tokens: 1, share: 1, colorIndex: 0 },
        ]}
        totalLabel="1"
        totalCaption="tokens"
        renderTokens={(tokens) => `${tokens}`}
        renderShare={(share) => `${share}`}
        summary="各模型的 Token 占比"
        colorOf={seriesColorAt}
      />,
    );
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("各模型的 Token 占比");
    expect(screen.getByTitle("非常非常长的模型名字")).toBeTruthy();
  });
});
