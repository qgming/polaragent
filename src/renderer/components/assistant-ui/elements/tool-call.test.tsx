/**
 * ToolCall 的标记测试（ui project / jsdom）。
 *
 * 这一条是针对一个真实缺陷的回归保护：失败的工具调用曾经走 vendored ToolFallback，而它的标记
 * 由 part 的 status 决定 —— aui 的 status 只表达「跑没跑完」，于是**失败也渲染成绿勾**，
 * 读起来就是成功。现在成功/失败都由本组件的 isError 表达。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCall, type ToolCallProps } from "./tool-call";

afterEach(cleanup);

const BASE: ToolCallProps = {
  label: "编辑了",
  activeLabel: "正在编辑",
  query: ".oint-tool-probe.tmp.md",
  request: '{"path":"…"}',
  result: "Could not find the exact text in .oint-tool-probe.tmp.md.",
  running: false,
  open: false,
  onOpenChange: () => {},
};

/** 收尾标记的 svg（成功=绿勾 / 失败=红叉）；未跑完时该位置为空 */
function markSvg(container: HTMLElement): SVGElement | null {
  return container.querySelector("span.ms-auto svg");
}

describe("ToolCall 的收尾标记", () => {
  it("成功：绿勾", () => {
    const { container } = render(<ToolCall {...BASE} />);
    const mark = markSvg(container);

    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("class")).toContain("text-emerald-500");
    expect(mark?.getAttribute("class")).not.toContain("text-red-600");
  });

  it("失败：红叉，且不再是绿勾（这正是「报错被读成成功」的回归点）", () => {
    const { container } = render(<ToolCall {...BASE} isError />);
    const mark = markSvg(container);

    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("class")).toContain("text-red-600");
    expect(mark?.getAttribute("class")).not.toContain("text-emerald-500");
  });

  it("失败时整行也转红（不只换图标）", () => {
    const { container } = render(<ToolCall {...BASE} isError />);
    const trigger = container.querySelector('[data-slot="tool-call"] button');

    expect(trigger?.getAttribute("class")).toContain("text-red-600/85");
  });

  it("运行中：两个标记都不出现", () => {
    const { container } = render(<ToolCall {...BASE} running />);

    expect(markSvg(container)).toBeNull();
  });

  it("标签与参数 chip 照常渲染", () => {
    render(<ToolCall {...BASE} isError />);

    expect(screen.getByText("编辑了")).toBeTruthy();
    expect(screen.getByText(".oint-tool-probe.tmp.md")).toBeTruthy();
  });
});
