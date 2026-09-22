/**
 * ToolCall 的标记与触发行测试（ui project / jsdom）。
 *
 * 两个回归点：
 *   1. **失败态不能是绿勾**。失败的工具调用曾经走 vendored ToolFallback，而它的标记由 part 的
 *      status 决定 —— aui 的 status 只表达「跑没跑完」，于是失败也渲染成绿勾，读起来就是成功。
 *      现在成功/失败由本组件的 isError 表达。
 *   2. **没有主参数时不渲染空 chip**。ask_user 的参数里没有一个字符串，旧实现会留下一枚
 *      只有 padding 的空灰胶囊（看起来像渲染 bug）。
 *
 * 展开区现在由调用方给（`detail` 必填），所以这里只断言触发行与展开区的可见性。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ToolCall, type ToolCallProps } from "./tool-call";

afterEach(cleanup);

const BASE: ToolCallProps = {
  label: "编辑了",
  activeLabel: "正在编辑",
  query: ".oint-tool-probe.tmp.md",
  detail: <p>详情内容</p>,
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

describe("触发行上的参数 chip", () => {
  /** 参数 chip 是触发行里那枚等宽小胶囊 */
  function chip(container: HTMLElement): Element | null {
    return container.querySelector(
      '[data-slot="tool-call"] button > span.bg-foreground\\/\\[0\\.06\\]',
    );
  }

  it("有主参数时照常显示", () => {
    const { container } = render(<ToolCall {...BASE} />);
    expect(chip(container)?.textContent).toBe(".oint-tool-probe.tmp.md");
  });

  it("没有主参数（空串）时不渲染那枚空胶囊", () => {
    // ask_user 的参数是 questions 数组，toolChip 解析不出任何字符串 →
    // 旧实现在行上留一枚只有 padding 的空灰胶囊，看起来像渲染 bug
    const { container } = render(<ToolCall {...BASE} query="" />);
    expect(chip(container)).toBeNull();
  });
});

/**
 * 运行中的输出预览。
 *
 * 没有它，长命令（装依赖、构建、跑测试）在界面上就是一张转圈的卡片 ——
 * 用户无从判断是在干活还是卡住了。内核一直在推 `tool_update`，早先没人订阅。
 *
 * 三条约定：只在运行中显示、只在有内容时显示、只显示尾部若干行。
 */
describe("ToolCall 的运行中输出预览", () => {
  function preview(container: HTMLElement): Element | null {
    return container.querySelector('[data-slot="tool-call-output"]');
  }

  it("运行中且有输出时显示", () => {
    const { container } = render(<ToolCall {...BASE} running output={"编译中…\n完成 3/10"} />);

    expect(preview(container)?.textContent).toContain("完成 3/10");
  });

  it("跑完之后不再显示（结果由展开区负责）", () => {
    const { container } = render(<ToolCall {...BASE} running={false} output={"编译中…"} />);

    expect(preview(container)).toBeNull();
  });

  it("没有输出时不占位", () => {
    const { container } = render(<ToolCall {...BASE} running />);

    expect(preview(container)).toBeNull();
  });

  it("空串不渲染（内核的首次 update 就是空内容）", () => {
    const { container } = render(<ToolCall {...BASE} running output="" />);

    expect(preview(container)).toBeNull();
  });

  it("长输出只显示尾部若干行，并标明省略了多少", () => {
    const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
    const { container } = render(<ToolCall {...BASE} running output={long} />);
    const text = preview(container)?.textContent ?? "";

    // 尾部在（最新进展与报错都在末尾），头部不在
    expect(text).toContain("line 20");
    expect(text).not.toContain("line 1\n");
    // 省略了多少要写出来，否则用户会以为这就是输出的开头
    expect(text).toContain("14");
  });

  it("行数不超过上限时不加省略标记", () => {
    const { container } = render(<ToolCall {...BASE} running output={"a\nb\nc"} />);
    const text = preview(container)?.textContent ?? "";

    expect(text).toContain("a");
    expect(text).not.toContain("略");
  });
});
