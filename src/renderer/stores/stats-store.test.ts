/**
 * stats-store 的加载与轮询规则（node project，store 本身不依赖 DOM）。
 *
 * 钉三条用户看得见的行为：
 *  1. **报告先到先显示**：已经有数据时刷新是静默的（不回到骨架屏）；
 *  2. **历史折叠没完就接着问**：`scanning.active` 为真时自动轮询，直到折完为止；
 *  3. **关掉模态窗就停**：`stop()` 之后在途请求的结果不许再写进状态，
 *     否则用户下次打开会看到一次莫名其妙的闪烁（或者更糟：轮询不停）。
 *
 * window.oint 是 store 唯一的外部依赖（IPC），逐条用例换成替身；不 mock 模块。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageStatsReport } from "@/shared/contracts/stats";
import { resetStatsStoreForTests, useStatsStore } from "./stats-store";

function reportFixture(patch: Partial<UsageStatsReport> = {}): UsageStatsReport {
  return {
    generatedAt: 1_700_000_000_000,
    today: "2026-09-24",
    totals: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0 },
    totalTokens: 111,
    sessions: {
      total: 2,
      chat: { sessions: 2, tokens: 111 },
      subagent: { sessions: 0, tokens: 0 },
    },
    activeDays: 1,
    peak: { date: "2026-09-24", tokens: 111 },
    longestSession: { sessionId: "s1", title: "会话", ms: 1000 },
    streak: { current: 1, longest: 1 },
    days: [{ date: "2026-09-24", tokens: 111, models: { "svc|m": 111 } }],
    models: [{ key: "svc|m", serviceId: "svc", modelId: "m", tokens: 111, share: 1 }],
    scanning: { active: false, scanned: 2, total: 2 },
    ...patch,
  };
}

function stubReport(...reports: UsageStatsReport[]) {
  const report = vi.fn();
  for (const value of reports) report.mockResolvedValueOnce(value);
  report.mockResolvedValue(reports[reports.length - 1] ?? reportFixture());
  vi.stubGlobal("window", { oint: { stats: { report } } });
  return report;
}

beforeEach(() => {
  resetStatsStoreForTests();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("load", () => {
  it("成功后写入报告并清掉错误", async () => {
    stubReport(reportFixture());
    await useStatsStore.getState().load();

    const state = useStatsStore.getState();
    expect(state.report?.totalTokens).toBe(111);
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it("IPC 失败时给可读的错误，不抛到界面", async () => {
    vi.stubGlobal("window", {
      oint: {
        stats: {
          report: vi.fn(async () => {
            throw new Error("Error invoking remote method 'stats:report': Error: 读取会话列表失败");
          }),
        },
      },
    });

    await expect(useStatsStore.getState().load()).resolves.toBeUndefined();
    const state = useStatsStore.getState();
    // 前缀被剥掉，只留主进程写的原因
    expect(state.error).toBe("读取会话列表失败");
    expect(state.report).toBeNull();
  });

  it("历史还在折叠时自动接着问，直到 scanning.active 为假", async () => {
    vi.useFakeTimers();
    const report = stubReport(
      reportFixture({ scanning: { active: true, scanned: 1, total: 3 } }),
      reportFixture({ scanning: { active: true, scanned: 2, total: 3 }, totalTokens: 222 }),
      reportFixture({ scanning: { active: false, scanned: 3, total: 3 }, totalTokens: 333 }),
    );

    await useStatsStore.getState().load();
    expect(useStatsStore.getState().report?.totalTokens).toBe(111);

    // 第一轮轮询
    await vi.advanceTimersByTimeAsync(400);
    expect(useStatsStore.getState().report?.totalTokens).toBe(222);

    // 第二轮轮询：折完就停
    await vi.advanceTimersByTimeAsync(400);
    expect(useStatsStore.getState().report?.totalTokens).toBe(333);

    // 再等一段时间不该再有请求
    await vi.advanceTimersByTimeAsync(2000);
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("轮询期间不回到加载态（界面不该闪骨架屏）", async () => {
    vi.useFakeTimers();
    stubReport(
      reportFixture({ scanning: { active: true, scanned: 1, total: 2 } }),
      reportFixture({ scanning: { active: false, scanned: 2, total: 2 } }),
    );

    await useStatsStore.getState().load();
    expect(useStatsStore.getState().loading).toBe(false);

    await vi.advanceTimersByTimeAsync(400);
    expect(useStatsStore.getState().loading).toBe(false);
    expect(useStatsStore.getState().report?.scanning.active).toBe(false);
  });

  it("stop() 之后在途的请求结果不再写进状态", async () => {
    let resolveReport: ((value: UsageStatsReport) => void) | undefined;
    vi.stubGlobal("window", {
      oint: {
        stats: {
          report: vi.fn(
            () =>
              new Promise<UsageStatsReport>((resolve) => {
                resolveReport = resolve;
              }),
          ),
        },
      },
    });

    const pending = useStatsStore.getState().load();
    useStatsStore.getState().stop();
    resolveReport?.(reportFixture({ totalTokens: 999 }));
    await pending;

    expect(useStatsStore.getState().report).toBeNull();
    expect(useStatsStore.getState().loading).toBe(false);
  });

  it("stop() 之后不再轮询（关掉模态窗就该安静下来）", async () => {
    vi.useFakeTimers();
    const report = stubReport(
      reportFixture({ scanning: { active: true, scanned: 1, total: 5 } }),
      reportFixture({ scanning: { active: true, scanned: 2, total: 5 } }),
    );

    await useStatsStore.getState().load();
    useStatsStore.getState().stop();
    await vi.advanceTimersByTimeAsync(2000);

    expect(report).toHaveBeenCalledTimes(1);
  });
});
