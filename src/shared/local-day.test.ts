import { describe, expect, it } from "vitest";
import { addDays, dayKeyOf, dayKeyToDate, diffDays } from "./local-day";

/**
 * 本地日期运算是统计口径的地基：热力图的格子、趋势图的横轴、连续天数三者
 * 都落在这些函数上。这里钉住三件最容易错的事：**本地日不等于 UTC 日**、
 * **日期键不能被 Date.parse 解析**、**跨月跨年加减**。
 */
describe("dayKeyOf", () => {
  it("按本地时区取日期，而不是 UTC", () => {
    // 本地时间 2026-09-24 00:30：UTC 那边还停在 23 号（东八区）
    const local = new Date(2026, 8, 24, 0, 30).getTime();
    expect(dayKeyOf(local)).toBe("2026-09-24");
  });

  it("补零到两位：9 月 4 日不是 2026-9-4", () => {
    expect(dayKeyOf(new Date(2026, 8, 4, 12).getTime())).toBe("2026-09-04");
  });
});

describe("addDays / diffDays", () => {
  it("跨月、跨年", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-01-01", -1)).toBe("2026-12-31");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("闰年 2 月", () => {
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2028-02-29", 1)).toBe("2028-03-01");
  });

  it("相差天数是整数（时区若有夏令时，那天只有 23 小时）", () => {
    // 若按毫秒直接除以 86400000，夏令时那天会算出 0.96/1.04 这种小数
    expect(diffDays("2026-03-07", "2026-03-08")).toBe(1);
    expect(diffDays("2026-03-08", "2026-03-09")).toBe(1);
    expect(diffDays("2026-09-24", "2026-09-17")).toBe(-7);
    expect(diffDays("2026-09-17", "2026-09-17")).toBe(0);
  });

  it("dayKeyToDate 给的是本地零点（不是 UTC 零点）", () => {
    const date = dayKeyToDate("2026-09-24");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8);
    expect(date.getDate()).toBe(24);
    expect(date.getHours()).toBe(0);
  });

  it("坏日期键按 1970-01-01 处理，不抛错（外部 JSON 可能被改坏）", () => {
    expect(addDays("不是日期", 0)).toBe("1970-01-01");
    expect(dayKeyToDate("2026-9-4").getFullYear()).toBe(1970);
  });
});
