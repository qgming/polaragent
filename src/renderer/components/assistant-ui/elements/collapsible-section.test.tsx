/**
 * 子智能体详情里的小节折叠（ui project / jsdom）。
 *
 * 这里钉的是**折叠控件本身**，不是某个具体面板：
 *   · 默认展开（打开面板就该看到内容，而不是先点一下）；
 *   · 点标题行收起 —— 全有或全无，收起后正文真的离开 DOM，不是裁到 N 行；
 *   · 标题是 h4、按钮在标题里：标题层级与控件语义都不丢；
 *   · 两个小节的读屏名分得开（面板里有「任务」与「汇报」两处同样的控件）；
 *   · 正文原样渲染在可折叠体里（markdown 由调用侧交给 MarkdownBlock 渲染，折叠换的是
 *     开关，不是渲染方式）。
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CollapsibleSection,
  SectionTitle,
} from "@/renderer/components/assistant-ui/elements/collapsible-section";

afterEach(cleanup);

describe("小节折叠", () => {
  it("默认展开：正文在，按钮报已展开并指向内容区", () => {
    render(
      <CollapsibleSection title="任务">
        <p>派出去的那段话</p>
      </CollapsibleSection>,
    );

    const toggle = screen.getByRole("button", { name: "任务" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("派出去的那段话")).toBeTruthy();

    const controlled = toggle.getAttribute("aria-controls");
    expect(controlled).not.toBeNull();
    expect(document.getElementById(controlled ?? "")).not.toBeNull();
  });

  it("点标题行收起：正文离开 DOM，只剩标题", () => {
    render(
      <CollapsibleSection title="汇报">
        <p>子智能体说的话</p>
      </CollapsibleSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: "汇报" }));

    const toggle = screen.getByRole("button", { name: "汇报" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("子智能体说的话")).toBeNull();
    // aria-controls 在收起态仍然指着内容区（Radix 默认只在展开时给，这里补上了）
    expect(toggle.getAttribute("aria-controls")).toBeTruthy();
  });

  it("再点一次回到展开：全文回来，不是裁一段", () => {
    render(
      <CollapsibleSection title="任务">
        <p>派出去的那段话</p>
      </CollapsibleSection>,
    );

    fireEvent.click(screen.getByRole("button", { name: "任务" }));
    fireEvent.click(screen.getByRole("button", { name: "任务" }));

    expect(screen.getByRole("button", { name: "任务" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("派出去的那段话")).toBeTruthy();
  });

  it("按钮包在 h4 里：标题语义与控件都在", () => {
    render(
      <CollapsibleSection title="任务">
        <p>派出去的那段话</p>
      </CollapsibleSection>,
    );

    const heading = screen.getByRole("heading", { level: 4 });
    expect(within(heading).getByRole("button", { name: "任务" })).toBeTruthy();
  });

  it("两处同样的控件靠标题分得开", () => {
    render(
      <>
        <CollapsibleSection title="任务">
          <p>甲</p>
        </CollapsibleSection>
        <CollapsibleSection title="汇报">
          <p>乙</p>
        </CollapsibleSection>
      </>,
    );

    expect(screen.getByRole("button", { name: "任务" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "汇报" })).toBeTruthy();
  });

  it("正文原样渲染在可折叠体里（渲染方式由调用侧决定）", () => {
    render(
      <CollapsibleSection title="任务">
        <strong>加粗的一句话</strong>
      </CollapsibleSection>,
    );

    // 组件只负责开合与外壳：正文是不是 markdown，由调用侧传什么进来决定
    expect(screen.getByText("加粗的一句话").tagName).toBe("STRONG");
  });
});

describe("不可折叠的小节标题", () => {
  it("是同一套标题排版，且不是按钮（转录那一节不折叠）", () => {
    render(<SectionTitle>执行记录</SectionTitle>);

    expect(screen.getByRole("heading", { level: 4 }).textContent).toBe("执行记录");
    expect(screen.queryByRole("button")).toBeNull();
  });
});
