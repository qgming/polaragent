import { describe, expect, it } from "vitest";
import type { SessionKind } from "@/shared/contracts/session";
import type { UsageScanProgress } from "@/shared/contracts/stats";
import { aggregateUsageReport, type SessionMeta } from "./usage-aggregate";
import { ROLLUP_VERSION, type RollupDay, type UsageRollup } from "./usage-rollup";

/**
 * 聚合层承载的全部是**口径**，所以这里逐条钉住它们：累计怎么算、峰值是哪一天、
 * 连续天数在「今天还没用」时怎么判、占比的分母是谁。
 */

function day(overrides: Partial<RollupDay> = {}): RollupDay {
  return { i: 0, o: 0, cr: 0, cw: 0, m: {}, ...overrides };
}

function rollup(
  sessions: Record<string, { days: Record<string, RollupDay>; first?: number; last?: number }>,
): UsageRollup {
  const out: UsageRollup = { version: ROLLUP_VERSION, sessions: {} };
  for (const [id, session] of Object.entries(sessions)) {
    out.sessions[id] = {
      seq: 1,
      seenUpdatedAt: 1,
      days: session.days,
      ...(session.first === undefined ? {} : { first: session.first }),
      ...(session.last === undefined ? {} : { last: session.last }),
    };
  }
  return out;
}

function metas(
  entries: Record<string, { title?: string | null; kind?: SessionKind }>,
): Map<string, SessionMeta> {
  return new Map(
    Object.entries(entries).map(([id, meta]) => [
      id,
      { title: meta.title ?? null, kind: meta.kind ?? "chat" },
    ]),
  );
}

const SCANNING_DONE: UsageScanProgress = { active: false, scanned: 2, total: 2 };

describe("aggregateUsageReport", () => {
  it("跨会话按日合并，总量是四个桶之和", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        a: { days: { "2026-09-24": day({ i: 10, o: 2, cr: 100, cw: 0 }) } },
        b: { days: { "2026-09-24": day({ i: 1, o: 3, cr: 0, cw: 5 }) } },
      }),
      sessions: metas({ a: {}, b: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 1_700_000_000_000,
    });

    expect(report.totalTokens).toBe(121);
    expect(report.totals).toEqual({
      inputTokens: 11,
      outputTokens: 5,
      cacheReadTokens: 100,
      cacheWriteTokens: 5,
    });
    expect(report.days).toHaveLength(1);
    expect(report.days[0]).toMatchObject({ date: "2026-09-24", tokens: 121 });
  });

  it("分模型的桶同时进「当天」与「模型合计」，占比按总量算", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        a: {
          days: {
            "2026-09-24": day({
              i: 10,
              o: 10,
              m: {
                "svc|big": { i: 10, o: 10, cr: 0, cw: 0 },
                "svc|small": { i: 0, o: 0, cr: 0, cw: 0 },
              },
            }),
            "2026-09-23": day({ o: 30, m: { "svc|big": { i: 0, o: 30, cr: 0, cw: 0 } } }),
          },
        },
      }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });

    // days 按日期升序：先 09-23，后 09-24
    expect(report.days[0]?.models).toEqual({ "svc|big": 30 });
    expect(report.days[1]?.models).toEqual({ "svc|big": 20 });
    expect(report.models).toHaveLength(1);
    expect(report.models[0]).toMatchObject({
      key: "svc|big",
      serviceId: "svc",
      modelId: "big",
      tokens: 50,
    });
    expect(report.models[0]?.share).toBeCloseTo(1);
  });

  it("模型按用量降序（图例与配色都按这个顺序取）", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        a: {
          days: {
            "2026-09-24": day({
              o: 6,
              m: {
                "svc|small": { i: 0, o: 1, cr: 0, cw: 0 },
                "svc|big": { i: 0, o: 5, cr: 0, cw: 0 },
              },
            }),
          },
        },
      }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.models.map((model) => model.modelId)).toEqual(["big", "small"]);
    expect(report.models[0]?.share).toBeCloseTo(5 / 6);
  });

  it("峰值取 token 最多的那一天，并带上日期", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        a: {
          days: {
            "2026-09-22": day({ o: 5 }),
            "2026-09-23": day({ o: 90 }),
            "2026-09-24": day({ o: 20 }),
          },
        },
      }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.peak).toEqual({ date: "2026-09-23", tokens: 90 });
    expect(report.activeDays).toBe(3);
    expect(report.days.map((entry) => entry.date)).toEqual([
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
    ]);
  });

  it("没有任何记录时是一份全 0 的报告，不是抛错", () => {
    const report = aggregateUsageReport({
      rollup: rollup({ a: { days: {} } }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.totalTokens).toBe(0);
    expect(report.peak).toEqual({ date: null, tokens: 0 });
    expect(report.days).toEqual([]);
    expect(report.models).toEqual([]);
    expect(report.streak).toEqual({ current: 0, longest: 0 });
    expect(report.longestSession).toEqual({ sessionId: null, title: null, ms: 0 });
    expect(report.sessions.total).toBe(1);
  });

  it("会话列表里没有的会话（已删除）不参与统计", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        alive: { days: { "2026-09-24": day({ o: 10 }) } },
        deleted: { days: { "2026-09-24": day({ o: 999 }) } },
      }),
      sessions: metas({ alive: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.totalTokens).toBe(10);
    expect(report.sessions.total).toBe(1);
  });
});

describe("连续天数", () => {
  const at = (today: string, days: string[]) =>
    aggregateUsageReport({
      rollup: rollup({
        a: { days: Object.fromEntries(days.map((date) => [date, day({ o: 1 })])) },
      }),
      sessions: metas({ a: {} }),
      today,
      scanning: SCANNING_DONE,
      now: 0,
    }).streak;

  it("今天有记录：从今天往回数", () => {
    expect(at("2026-09-24", ["2026-09-22", "2026-09-23", "2026-09-24"])).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it("今天还没记录：从昨天往回数（一天没过完不算中断）", () => {
    expect(at("2026-09-24", ["2026-09-22", "2026-09-23"])).toEqual({ current: 2, longest: 2 });
  });

  it("昨天也没有记录时归零", () => {
    expect(at("2026-09-24", ["2026-09-20", "2026-09-21"]).current).toBe(0);
  });

  it("最长连续与当前连续是两件事（当前断了、历史上更长）", () => {
    expect(
      at("2026-09-24", [
        "2026-09-01",
        "2026-09-02",
        "2026-09-03",
        "2026-09-04",
        "2026-09-20",
        "2026-09-21",
      ]),
    ).toEqual({ current: 0, longest: 4 });
  });

  it("跨月连续也算连续", () => {
    expect(at("2026-10-01", ["2026-09-29", "2026-09-30", "2026-10-01"])).toEqual({
      current: 3,
      longest: 3,
    });
  });

  it("同一天多条记录只算一天", () => {
    // 卷账本已经按日分桶，这里再确认一次「一天」的粒度是日期而不是记录数
    expect(at("2026-09-24", ["2026-09-24"])).toEqual({ current: 1, longest: 1 });
  });
});

describe("最长聊天与种类拆分", () => {
  it("跨度取首末时间差，标题来自会话列表", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        a: { days: { "2026-09-24": day({ o: 1 }) }, first: 1_000, last: 4_000 },
        b: { days: { "2026-09-24": day({ o: 1 }) }, first: 0, last: 90_000 },
      }),
      sessions: metas({ a: { title: "短的" }, b: { title: "长的" } }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.longestSession).toEqual({ sessionId: "b", title: "长的", ms: 90_000 });
  });

  it("没有标题的会话给 null（界面自己兜底文案）", () => {
    const report = aggregateUsageReport({
      rollup: rollup({ a: { days: { "2026-09-24": day({ o: 1 }) }, first: 5, last: 6 } }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.longestSession.title).toBeNull();
  });

  it("只有 first/last 都有记录的会话才参与最长跨度的比较", () => {
    const report = aggregateUsageReport({
      rollup: rollup({ a: { days: {} } }),
      sessions: metas({ a: {} }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.longestSession.ms).toBe(0);
  });

  it("会话数与 token 按 chat / subagent 拆开，计数用会话列表（含没用过的）", () => {
    const report = aggregateUsageReport({
      rollup: rollup({
        c1: { days: { "2026-09-24": day({ o: 10 }) } },
        s1: { days: { "2026-09-24": day({ o: 90 }) } },
      }),
      sessions: metas({
        c1: { kind: "chat" },
        c2: { kind: "chat" },
        s1: { kind: "subagent" },
      }),
      today: "2026-09-24",
      scanning: SCANNING_DONE,
      now: 0,
    });
    expect(report.sessions).toEqual({
      total: 3,
      chat: { sessions: 2, tokens: 10 },
      subagent: { sessions: 1, tokens: 90 },
    });
  });
});
