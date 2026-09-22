import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatRelativeDay, formatTime, formatTokens } from "./format";

describe("formatRelativeDay", () => {
  // 固定"今天"为 2026-09-10 12:00（本地时区，避免 DST 干扰）
  const now = new Date(2026, 8, 10, 12, 0).getTime();

  it("今天返回「今天」", () => {
    expect(formatRelativeDay(new Date(2026, 8, 10, 0, 30).getTime(), now)).toBe("今天");
  });

  it("昨天返回「昨天」", () => {
    expect(formatRelativeDay(new Date(2026, 8, 9, 23, 0).getTime(), now)).toBe("昨天");
  });

  it("更早返回 M月D日", () => {
    expect(formatRelativeDay(new Date(2026, 8, 1, 8, 0).getTime(), now)).toBe("9月1日");
  });

  it("跨年返回带年份", () => {
    expect(formatRelativeDay(new Date(2025, 11, 31, 23, 0).getTime(), now)).toBe("2025年12月31日");
  });
});

describe("formatTime", () => {
  it("HH:mm 补零", () => {
    expect(formatTime(new Date(2026, 8, 10, 9, 5).getTime())).toBe("09:05");
    expect(formatTime(new Date(2026, 8, 10, 23, 59).getTime())).toBe("23:59");
  });
});

describe("formatTokens", () => {
  it("千以内原样", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  it("千以上用 k，保留 1 位小数", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(1_234)).toBe("1.2k");
    expect(formatTokens(100_000)).toBe("100k");
  });

  it("百万以上用 M，保留 2 位小数", () => {
    expect(formatTokens(1_240_000)).toBe("1.24M");
    expect(formatTokens(12_000_000)).toBe("12M");
  });

  it("非法输入返回 0", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("10 秒内保留 1 位小数", () => {
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(1_200)).toBe("1.2s");
    expect(formatDuration(1_000)).toBe("1s");
  });

  it("10 秒到 1 分钟取整秒", () => {
    expect(formatDuration(10_000)).toBe("10s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("1 分钟以上、1 小时以内为 XmYs", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(123_000)).toBe("2m3s");
    expect(formatDuration(3_599_000)).toBe("59m59s");
  });

  /**
   * 小时这一档是补上的：作业活得比一轮久得多，一个挂了几小时的进程按分钟报会变成
   * `667m41s` —— 读数是**对的**（那正是用户截图里的原始毛病）但没法读，
   * 人脑要自己去除以 60 才知道它快 11 小时了。
   *
   * 到了小时档不再带秒：那个精度已经没有信息量了。
   */
  it("1 小时以上为 XhYm（不再按分钟累计）", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_660_000)).toBe("1h1m");
    // 截图里的那个读数：667m41s = 11h7m41s
    expect(formatDuration(40_061_000)).toBe("11h7m");
    expect(formatDuration(86_400_000)).toBe("24h");
  });
});

describe("formatBytes", () => {
  it("各级单位", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1_536)).toBe("1.5KB");
    expect(formatBytes(3_355_443)).toBe("3.2MB");
    expect(formatBytes(1_180_116_096)).toBe("1.1GB");
  });
});
