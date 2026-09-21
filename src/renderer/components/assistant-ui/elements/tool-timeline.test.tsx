/**
 * 工具轨迹（ToolTimeline）的渲染测试（ui project / jsdom）。
 *
 * 盯住一条回归：**没有主参数时不渲染空 chip**。
 *
 * `ask_user` 的参数是 `questions` 数组（里面没有一个字符串），`toolChip` 因此返回空串。
 * 旧实现在轨迹行里无条件渲染那枚 chip —— 于是「提问」后面跟着一枚只有 padding 的空灰胶囊，
 * 看起来像渲染 bug（用户截图里报的就是这个）。`ToolCall` 的触发行早就有 `query !== ""`
 * 的判断，轨迹这条路径漏了，两条路径的口径必须一致。
 *
 * 断言口径取 DOM 里那枚 chip 元素在不在，而不是 class：样式细节会变，而
 * 「有没有一个空的可视元素」是这件事的本质。
 */

import { cleanup, render } from "@testing-library/react";
import { ChevronRightIcon } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { type TimelineStep, ToolTimeline } from "./tool-timeline";

afterEach(cleanup);

function renderTimeline(steps: TimelineStep[]) {
  return render(
    <ToolTimeline
      steps={steps}
      visibleSteps={steps.length}
      streaming={false}
      open
      onOpenChange={() => {}}
      restingLabel={`${steps.length} 个工具`}
      activeLabel="正在工作"
      stats={[]}
    />,
  );
}

/** 参数 chip：行里那枚等宽小胶囊（与动词标签、图标区分开） */
function chips(container: HTMLElement): Element[] {
  return [...container.querySelectorAll(".bg-foreground\\/\\[0\\.06\\]")];
}

const base = { icon: ChevronRightIcon };

describe("轨迹行的参数 chip", () => {
  it("有 chip 时照常渲染", () => {
    const { container } = renderTimeline([
      { ...base, verb: "读取", chip: "src/a.ts" },
      { ...base, verb: "检索", chip: "foo" },
    ]);

    const found = chips(container);
    expect(found).toHaveLength(2);
    expect(found.map((el) => el.textContent)).toEqual(["src/a.ts", "foo"]);
  });

  it("chip 为空串时不渲染那枚空胶囊（ask_user 的参数里没有字符串）", () => {
    const { container } = renderTimeline([
      { ...base, verb: "提问", chip: "" },
      // 混一条有 chip 的：确认过滤是按行判的，不是整块不渲染
      { ...base, verb: "读取", chip: "src/a.ts" },
    ]);

    const found = chips(container);
    expect(found).toHaveLength(1);
    expect(found[0]?.textContent).toBe("src/a.ts");
  });

  it("所有行的 chip 都为空时，一个胶囊都不出现", () => {
    const { container } = renderTimeline([
      { ...base, verb: "提问", chip: "" },
      { ...base, verb: "查看子智能体", chip: "" },
    ]);

    expect(chips(container)).toHaveLength(0);
  });

  it("动词标签照常显示（chip 被滤掉不影响这一行）", () => {
    const { container } = renderTimeline([{ ...base, verb: "提问", chip: "" }]);

    expect(container.textContent).toContain("提问");
  });
});
