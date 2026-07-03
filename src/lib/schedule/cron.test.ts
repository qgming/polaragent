import { describe, expect, it } from "vitest";

import { nextCronOccurrence, parseCronExpression, validateCronConfig } from "./cron";

describe("parseCronExpression", () => {
  it("parses wildcard, ranges, steps, and lists", () => {
    const parsed = parseCronExpression("*/15 9-17 * 1,6,12 1-5");

    expect(parsed.minute.values.has(0)).toBe(true);
    expect(parsed.minute.values.has(15)).toBe(true);
    expect(parsed.minute.values.has(45)).toBe(true);
    expect(parsed.hour.values.has(9)).toBe(true);
    expect(parsed.hour.values.has(17)).toBe(true);
    expect(parsed.month.values.has(6)).toBe(true);
    expect(parsed.dayOfWeek.values.has(5)).toBe(true);
  });

  it("maps sunday value 7 to 0", () => {
    const parsed = parseCronExpression("0 8 * * 7");
    expect(parsed.dayOfWeek.values.has(0)).toBe(true);
  });
});

describe("nextCronOccurrence", () => {
  it("returns the next top-of-hour occurrence", () => {
    const from = new Date(2026, 6, 3, 10, 5, 42).getTime();
    const next = nextCronOccurrence("0 * * * *", from);

    expect(new Date(next).getHours()).toBe(11);
    expect(new Date(next).getMinutes()).toBe(0);
  });

  it("supports exact day-of-week schedules", () => {
    const from = new Date(2026, 6, 3, 10, 0, 0).getTime();
    const next = nextCronOccurrence("30 9 * * 6", from);
    const date = new Date(next);

    expect(date.getDay()).toBe(6);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(30);
  });
});

describe("validateCronConfig", () => {
  it("throws on invalid cron expressions", () => {
    expect(() => validateCronConfig({ kind: "cron", expr: "61 * * * *" })).toThrow();
  });
});
