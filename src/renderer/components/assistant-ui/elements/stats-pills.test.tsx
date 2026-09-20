/**
 * 会话状态条（StatusBar / 两个胶囊与两个弹层）的渲染测试（ui project / jsdom）。
 *
 * 验的是**数据链与读数**，不只是外观：
 *   · 计数与 tok/s、Token 总量与缓存命中率都按 DSH 的口径算（缓存命中率 = 缓存读取 /
 *     三个互斥输入桶之和，而不是 / 总量）
 *   · 两个胶囊在数据缺失时各自不渲染，两者都缺时整条不渲染
 *   · 点击胶囊才出弹层（默认不在 DOM 里），弹层里的明细行必须与传入数据一致
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import type { SessionStats, SessionTokenUsage } from "@/shared/contracts";
import { StatusBar } from "./stats-pills";

afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

function stats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    turns: 1,
    steps: 25,
    llmMs: 351_000,
    toolMs: 12_500,
    ttftMs: 13_700,
    ttftSteps: 1,
    decodeMs: 8_000,
    decodeTokens: 13_184,
    ...overrides,
  };
}

function usage(overrides: Partial<SessionTokenUsage> = {}): SessionTokenUsage {
  return {
    uncachedInputTokens: 72_388,
    outputTokens: 14_153,
    cacheReadTokens: 1_054_208,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

describe("StatusBar", () => {
  it("两个数据都没有时渲染空态行（高度恒定，输入框不跳动）", () => {
    const { container } = render(<StatusBar />);
    const bar = container.querySelector('[data-slot="composer-stats"]');
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute("data-empty")).toBe("true");
    // 空态不渲染任何胶囊
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("只有统计时只渲染时间胶囊", () => {
    render(<StatusBar stats={stats()} />);
    expect(screen.getByText(/1 轮 25 步/)).toBeTruthy();
    // 用量胶囊不在（既不显示 tok 总量）
    expect(screen.queryByText(/缓存命中/)).toBeNull();
  });

  it("steps 为 0 的统计视为无数据（空会话不显示时间胶囊）", () => {
    render(<StatusBar stats={stats({ steps: 0 })} tokenUsage={usage()} />);
    expect(screen.queryByText(/轮/)).toBeNull();
    expect(screen.getByText(/缓存命中/)).toBeTruthy();
  });

  it("时间胶囊：轮/步 + tok/s 读数（decodeTokens / decodeMs）", () => {
    render(<StatusBar stats={stats()} />);
    // 13184 token / 8s = 1648 tok/s
    expect(screen.getByText("1 轮 25 步")).toBeTruthy();
    expect(screen.getByText("1648 tok/s")).toBeTruthy();
  });

  it("用量胶囊：总量 = 输入三桶 + 输出；缓存命中率的分母是三个输入桶之和", () => {
    render(<StatusBar tokenUsage={usage()} />);
    // 72388 + 1054208 + 0 + 14153 = 1,140,749 → 1.1M
    expect(screen.getByText("1.1M tok")).toBeTruthy();
    // 1054208 / (72388 + 1054208) = 93.57% → 94%
    expect(screen.getByText("缓存命中 94%")).toBeTruthy();
  });

  it("时间弹层默认不渲染，点击后出现明细（模型用时 / 工具用时 / TTFT / TPS）", () => {
    render(<StatusBar stats={stats()} />);
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /1 轮 25 步/ }));

    const panel = screen.getByRole("dialog", { name: "会话统计" });
    expect(panel).toBeTruthy();
    expect(screen.getByText("模型用时")).toBeTruthy();
    expect(screen.getByText("5 分 51 秒")).toBeTruthy();
    expect(screen.getByText("工具调用用时")).toBeTruthy();
    expect(screen.getByText("12.5 秒")).toBeTruthy();
    expect(screen.getByText("首 token 平均（TTFT）")).toBeTruthy();
    expect(screen.getByText("13.7 秒")).toBeTruthy();
    expect(screen.getByText("输出速度（TPS）")).toBeTruthy();
  });

  it("用量弹层：标题带精确总量，明细给出四个桶", () => {
    render(<StatusBar tokenUsage={usage()} />);
    fireEvent.click(screen.getByRole("button", { name: /1.1M tok/ }));

    const panel = screen.getByRole("dialog", { name: "Token 用量" });
    expect(panel).toBeTruthy();
    expect(screen.getByText("1,140,749 tok")).toBeTruthy();
    expect(screen.getByText("缓存命中")).toBeTruthy();
    expect(screen.getByText("72,388 tok")).toBeTruthy();
    expect(screen.getByText("1,054,208 tok")).toBeTruthy();
    expect(screen.getByText("14,153 tok")).toBeTruthy();
  });

  it("缓存写入为 0 时该行不显示，非 0 时显示", () => {
    const { unmount } = render(<StatusBar tokenUsage={usage()} />);
    fireEvent.click(screen.getByRole("button", { name: /1.1M tok/ }));
    expect(screen.queryByText("缓存写入")).toBeNull();
    unmount();

    render(<StatusBar tokenUsage={usage({ cacheWriteTokens: 5_000 })} />);
    fireEvent.click(screen.getByRole("button", { name: /1.1M tok/ }));
    expect(screen.getByText("缓存写入")).toBeTruthy();
    expect(screen.getByText("5,000 tok")).toBeTruthy();
  });

  it("没有计费输入时不给缓存命中率（分母为 0 不能编造 0%）", () => {
    render(
      <StatusBar
        tokenUsage={usage({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })}
      />,
    );
    expect(screen.queryByText(/缓存命中/)).toBeNull();
    // 总量仍显示（只剩输出）
    expect(screen.getByText("14.2K tok")).toBeTruthy();
  });

  it("Escape 关闭弹层", () => {
    render(<StatusBar stats={stats()} />);
    fireEvent.click(screen.getByRole("button", { name: /1 轮 25 步/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
