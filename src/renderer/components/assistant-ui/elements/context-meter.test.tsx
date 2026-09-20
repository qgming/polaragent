/**
 * 上下文环（ContextMeter）的渲染测试（ui project / jsdom）。
 *
 * 验的是**读数与分解的算术**：
 *   · 百分比 = 已用 / 窗口，读数与 aria 一同给出
 *   · 展开面板里的三段（系统提示词 / 工具定义 / 对话消息）按 breakdown 原值显示
 *   · 无窗口 / 无用量时整个组件不渲染（新会话不占位）
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import type { ContextBreakdown } from "@/shared/contracts";
import { ContextMeter } from "./context-meter";

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const BREAKDOWN: ContextBreakdown = {
  systemTokens: 1_800,
  toolsTokens: 7_100,
  messageTokens: 63_800,
};

describe("ContextMeter", () => {
  it("没有用量时不渲染（新会话不占位）", () => {
    const { container } = render(
      <ContextMeter usedTokens={0} contextWindow={1_000_000} breakdown={BREAKDOWN} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("窗口未知时不渲染（算不出百分比就不编）", () => {
    const { container } = render(
      <ContextMeter usedTokens={82_500} contextWindow={0} breakdown={BREAKDOWN} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("环按钮带百分比读数（82500 / 1M ≈ 8%）", () => {
    render(<ContextMeter usedTokens={82_500} contextWindow={1_000_000} breakdown={BREAKDOWN} />);
    expect(screen.getByRole("button", { name: "上下文已用 8%" })).toBeTruthy();
  });

  it("默认不展开面板，点击后出现三段分解", () => {
    render(<ContextMeter usedTokens={82_500} contextWindow={1_000_000} breakdown={BREAKDOWN} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "上下文已用 8%" }));

    expect(screen.getByRole("dialog", { name: "上下文已用" })).toBeTruthy();
    expect(screen.getByText("系统提示词")).toBeTruthy();
    expect(screen.getByText("~1.8K")).toBeTruthy();
    expect(screen.getByText("工具定义")).toBeTruthy();
    expect(screen.getByText("~7.1K")).toBeTruthy();
    expect(screen.getByText("对话消息")).toBeTruthy();
    expect(screen.getByText("~63.8K")).toBeTruthy();
    // 头部读数：~82.5K / 1M
    expect(screen.getByText(/~82\.5K \/ 1M/)).toBeTruthy();
  });

  it("没有分解数据时面板仍可用，只是不给三段图例", () => {
    render(<ContextMeter usedTokens={82_500} contextWindow={1_000_000} />);
    fireEvent.click(screen.getByRole("button", { name: "上下文已用 8%" }));

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.queryByText("系统提示词")).toBeNull();
  });

  it("百分比超过 100 时钳到 100（不会给出 120% 这类读数）", () => {
    render(<ContextMeter usedTokens={1_500_000} contextWindow={1_000_000} />);
    expect(screen.getByRole("button", { name: "上下文已用 100%" })).toBeTruthy();
  });

  it("切会话（resetKey 变化）时收起面板", () => {
    const { rerender } = render(
      <ContextMeter
        usedTokens={82_500}
        contextWindow={1_000_000}
        breakdown={BREAKDOWN}
        resetKey="s1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "上下文已用 8%" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    rerender(
      <ContextMeter
        usedTokens={82_500}
        contextWindow={1_000_000}
        breakdown={BREAKDOWN}
        resetKey="s2"
      />,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
