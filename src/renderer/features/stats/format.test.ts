import { describe, expect, it } from "vitest";
import {
  formatDayLabel,
  formatDuration,
  formatMonthLabel,
  formatPercent,
  formatTokens,
} from "./format";

/** 假的 t：只把键与参数拼出来，这样断言不依赖词条表的内容 */
const fakeT = (key: string, options?: Record<string, unknown>): string =>
  `${key}:${JSON.stringify(options ?? {})}`;

describe("formatTokens", () => {
  it("中文按万/亿，英文按 K/M/B（同一份数据、两种读法）", () => {
    expect(formatTokens(1_989_374_821, "zh-CN")).toBe("19.9亿");
    expect(formatTokens(42_543_000, "zh-CN")).toBe("4254.3万");
    expect(formatTokens(1_989_374_821, "en-US")).toBe("2B");
    expect(formatTokens(42_543_000, "en-US")).toBe("42.5M");
  });

  it("小于 1000 给整数", () => {
    expect(formatTokens(0, "zh-CN")).toBe("0");
    expect(formatTokens(999.4, "en-US")).toBe("999");
  });

  it("坏值不产生 NaN", () => {
    expect(formatTokens(Number.NaN, "zh-CN")).toBe("0");
  });
});

describe("formatPercent", () => {
  it("小于 10% 保留一位小数，其余取整", () => {
    expect(formatPercent(0.81, "en-US")).toBe("81%");
    expect(formatPercent(0.16, "en-US")).toBe("16%");
    expect(formatPercent(0.028, "en-US")).toBe("2.8%");
    expect(formatPercent(0.004, "en-US")).toBe("0.4%");
  });

  it("0 与 100 是两个端点，不出现 0.0% / 100.0%", () => {
    expect(formatPercent(0, "en-US")).toBe("0%");
    expect(formatPercent(1, "en-US")).toBe("100%");
  });

  /**
   * 两条「不撒谎」的边界：99.7% 不能写成 100%（那意味着「只有这一个模型」），
   * 而 0.03% 这类四舍五入就是 0 的占比要写「<0.1%」而不是「0%」。
   */
  it("接近 100% 但不满时保留一位小数", () => {
    expect(formatPercent(0.997, "en-US")).toBe("99.7%");
    expect(formatPercent(0.9999, "en-US")).toBe("100%");
  });

  it("极小但非零的占比写 <0.1%，不写成 0%", () => {
    expect(formatPercent(0.0003, "en-US")).toBe("<0.1%");
    expect(formatPercent(0.0003, "zh-CN")).toBe("<0.1%");
  });

  it("坏值被夹到 [0, 100]", () => {
    expect(formatPercent(Number.NaN, "en-US")).toBe("0%");
    expect(formatPercent(5, "en-US")).toBe("100%");
  });
});

describe("formatDuration", () => {
  it("按量级分段：秒 / 分钟 / 小时分钟 / 天小时", () => {
    expect(formatDuration(45_000, fakeT)).toContain("stats.durationSeconds");
    expect(formatDuration(90_000, fakeT)).toContain("stats.durationMinutes");
    expect(formatDuration(4 * 3_600_000 + 27 * 60_000, fakeT)).toContain("stats.durationHours");
    expect(formatDuration(50 * 3_600_000, fakeT)).toContain("stats.durationDays");
  });

  it("小时段带上余下的分钟数", () => {
    expect(formatDuration(4 * 3_600_000 + 27 * 60_000, fakeT)).toBe(
      'stats.durationHours:{"hours":4,"minutes":27}',
    );
  });

  it("负值与 0 都按 0 秒处理（时钟回拨不该显示负时长）", () => {
    expect(formatDuration(-1000, fakeT)).toBe('stats.durationSeconds:{"seconds":0}');
    expect(formatDuration(0, fakeT)).toBe('stats.durationSeconds:{"seconds":0}');
  });
});

describe("日期读数", () => {
  it("横轴/提示按语言格式化", () => {
    expect(formatDayLabel("2026-09-17", "zh-CN")).toContain("17");
    expect(formatDayLabel("2026-09-17", "en-US")).toMatch(/Sep/);
    expect(formatMonthLabel("2026-10-01", "en-US")).toMatch(/Oct/);
  });

  it("日期键按本地日解析：不会因为 UTC 解释而挪到前一天", () => {
    // 若用 Date.parse("2026-09-01")（按 UTC 解析），UTC+8 会显示成 8 月 31 日
    expect(formatDayLabel("2026-09-01", "zh-CN")).toContain("1");
    expect(formatDayLabel("2026-09-01", "zh-CN")).not.toContain("31");
  });
});
