import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UsageSample } from "@/main/pisdk/session-store";
import {
  applyUsageSamples,
  emptyRollup,
  isZeroSample,
  modelKeyOf,
  parseRollup,
  pruneRollup,
  ROLLUP_VERSION,
  type RollupSession,
  readRollupFile,
  rollupFilePath,
  splitModelKey,
  writeRollupFile,
} from "./usage-rollup";

const SESSION: RollupSession = { seq: 0, seenUpdatedAt: 0, days: {} };

/** 本地某天的某个时刻（用本地构造器，避免时区把测试日期挪走） */
function at(year: number, month: number, day: number, hour = 12, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

function sample(overrides: Partial<UsageSample> & { at: number }): UsageSample {
  return {
    serviceId: "svc",
    modelId: "m1",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("模型键", () => {
  it("serviceId|modelId，modelId 里带斜杠也不会拆错", () => {
    expect(modelKeyOf("svc-1", "deepseek/deepseek-v4-flash")).toBe(
      "svc-1|deepseek/deepseek-v4-flash",
    );
    expect(splitModelKey("svc-1|deepseek/deepseek-v4-flash")).toEqual({
      serviceId: "svc-1",
      modelId: "deepseek/deepseek-v4-flash",
    });
  });

  it("缺 serviceId 时只留 modelId（服务被删掉的历史记录）", () => {
    expect(modelKeyOf(undefined, "glm-4")).toBe("glm-4");
    expect(splitModelKey("glm-4")).toEqual({ serviceId: "", modelId: "glm-4" });
  });

  it("两个都没有时是 unknown，不是空键", () => {
    expect(modelKeyOf(undefined, undefined)).toBe("unknown");
    expect(splitModelKey("unknown")).toEqual({ serviceId: "", modelId: "unknown" });
  });
});

describe("applyUsageSamples", () => {
  it("按本地日与模型分别累加四个桶", () => {
    const folded = applyUsageSamples(SESSION, [
      sample({ at: at(2026, 9, 24, 9), modelId: "a", inputTokens: 10, outputTokens: 1 }),
      sample({ at: at(2026, 9, 24, 20), modelId: "a", inputTokens: 5, cacheReadTokens: 100 }),
      sample({ at: at(2026, 9, 24, 21), modelId: "b", outputTokens: 7 }),
      sample({ at: at(2026, 9, 23, 23), modelId: "a", outputTokens: 2 }),
    ]);

    expect(Object.keys(folded.days).sort()).toEqual(["2026-09-23", "2026-09-24"]);
    const day = folded.days["2026-09-24"];
    expect(day).toMatchObject({ i: 15, o: 8, cr: 100, cw: 0 });
    expect(day?.m["svc|a"]).toEqual({ i: 15, o: 1, cr: 100, cw: 0 });
    expect(day?.m["svc|b"]).toEqual({ i: 0, o: 7, cr: 0, cw: 0 });
    expect(folded.days["2026-09-23"]?.o).toBe(2);
  });

  it("四个桶全为 0 的样本不占一天（供应商没上报用量的那条消息）", () => {
    const zero = sample({ at: at(2026, 9, 24) });
    expect(isZeroSample(zero)).toBe(true);
    const folded = applyUsageSamples(SESSION, [zero]);
    expect(Object.keys(folded.days)).toEqual([]);
    expect(folded.first).toBeUndefined();
  });

  it("first / last 取时间的极值，而不是首末条（fork 复制来的条目顺序会乱）", () => {
    const folded = applyUsageSamples(SESSION, [
      sample({ at: at(2026, 9, 24, 10), outputTokens: 1 }),
      sample({ at: at(2026, 9, 20, 10), outputTokens: 1 }),
      sample({ at: at(2026, 9, 22, 10), outputTokens: 1 }),
    ]);
    expect(folded.first).toBe(at(2026, 9, 20, 10));
    expect(folded.last).toBe(at(2026, 9, 24, 10));
  });

  it("since 之前的样本被丢掉：fork 复制过来的历史不该重复计一遍", () => {
    const since = at(2026, 9, 24, 0);
    const folded = applyUsageSamples(
      SESSION,
      [
        sample({ at: at(2026, 9, 20, 10), outputTokens: 999 }),
        sample({ at: at(2026, 9, 24, 10), outputTokens: 1 }),
      ],
      since,
    );
    expect(Object.keys(folded.days)).toEqual(["2026-09-24"]);
    expect(folded.first).toBe(at(2026, 9, 24, 10));
  });

  it("不修改原对象（纯函数）：原来的会话条目保持原样", () => {
    const folded = applyUsageSamples(SESSION, [sample({ at: at(2026, 9, 24), outputTokens: 1 })]);
    expect(Object.keys(SESSION.days)).toEqual([]);
    expect(folded).not.toBe(SESSION);
  });

  it("游标与 updatedAt 快照原样带过（折叠本身不改这两样）", () => {
    const folded = applyUsageSamples({ seq: 42, seenUpdatedAt: 1234, days: {} }, [
      sample({ at: at(2026, 9, 24), outputTokens: 1 }),
    ]);
    expect(folded.seq).toBe(42);
    expect(folded.seenUpdatedAt).toBe(1234);
  });

  it("空样本直接返回原对象（稳态下每次统计都不该产生新对象）", () => {
    expect(applyUsageSamples(SESSION, [])).toBe(SESSION);
  });
});

describe("pruneRollup", () => {
  const rollup = {
    version: ROLLUP_VERSION,
    sessions: {
      a: { seq: 1, seenUpdatedAt: 1, days: {} },
      b: { seq: 1, seenUpdatedAt: 1, days: {} },
    },
  };

  it("丢掉不存在的会话", () => {
    const pruned = pruneRollup(rollup, new Set(["a"]));
    expect(Object.keys(pruned.sessions)).toEqual(["a"]);
  });

  it("keep 为空时**原样返回**：会话列表读失败不能抹掉历史用量", () => {
    const pruned = pruneRollup(rollup, new Set());
    expect(pruned).toBe(rollup);
  });

  it("没有变化时返回同一个引用（调用方据此决定要不要落盘）", () => {
    expect(pruneRollup(rollup, new Set(["a", "b"]))).toBe(rollup);
  });
});

describe("parseRollup", () => {
  it("认识自己写出来的形状", () => {
    const parsed = parseRollup({
      version: ROLLUP_VERSION,
      sessions: {
        s1: {
          seq: 7,
          seenUpdatedAt: 100,
          first: 10,
          last: 20,
          days: {
            "2026-09-24": {
              i: 1,
              o: 2,
              cr: 3,
              cw: 4,
              m: { "svc|m": { i: 1, o: 2, cr: 3, cw: 4 } },
            },
          },
        },
      },
    });
    expect(parsed.sessions.s1?.seq).toBe(7);
    expect(parsed.sessions.s1?.days["2026-09-24"]?.m["svc|m"]).toEqual({
      i: 1,
      o: 2,
      cr: 3,
      cw: 4,
    });
    expect(parsed.sessions.s1?.first).toBe(10);
  });

  it("版本不认识就整份作废（宁可重扫，也不用语义不同的数据算）", () => {
    expect(parseRollup({ version: 99, sessions: { s: { seq: 1, days: {} } } }).sessions).toEqual(
      {},
    );
  });

  it("坏条目跳过、坏顶层回退空账本，绝不抛错", () => {
    expect(parseRollup(null).sessions).toEqual({});
    expect(parseRollup("字符串").sessions).toEqual({});
    expect(parseRollup([]).sessions).toEqual({});
    const parsed = parseRollup({
      version: ROLLUP_VERSION,
      sessions: { good: { seq: 1, days: {} }, bad: "不是对象", bad2: { seq: 1, days: 5 } },
    });
    expect(Object.keys(parsed.sessions)).toEqual(["good"]);
  });

  it("缺字段按 0 补齐，坏数字不吞掉整条", () => {
    const parsed = parseRollup({
      version: ROLLUP_VERSION,
      sessions: { s: { days: { "2026-09-24": { i: "很多", o: 2 } } } },
    });
    expect(parsed.sessions.s?.seq).toBe(0);
    expect(parsed.sessions.s?.days["2026-09-24"]).toEqual({ i: 0, o: 2, cr: 0, cw: 0, m: {} });
  });

  it("空账本的形状与 ROLLUP_VERSION 一致", () => {
    expect(emptyRollup()).toEqual({ version: ROLLUP_VERSION, sessions: {} });
  });
});

describe("磁盘往返", () => {
  it("写出去读回来一致；文件缺失时给空账本", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oint-rollup-"));
    dirs.push(dir);
    const file = rollupFilePath(dir);
    expect(file.endsWith("usage-stats.json")).toBe(true);

    await expect(readRollupFile(file)).resolves.toEqual(emptyRollup());

    const rollup = applyUsageSamples({ seq: 3, seenUpdatedAt: 9, days: {} }, [
      sample({ at: at(2026, 9, 24), inputTokens: 5 }),
    ]);
    await writeRollupFile(file, { version: ROLLUP_VERSION, sessions: { s1: rollup } });
    const read = await readRollupFile(file);
    expect(read.sessions.s1?.days).toEqual(rollup.days);
  });

  it("文件被写坏时回退空账本（统计是派生数据，坏了重扫即可）", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oint-rollup-bad-"));
    dirs.push(dir);
    const file = rollupFilePath(dir);
    await writeFile(file, "{ 这不是 JSON", "utf8");
    await expect(readRollupFile(file)).resolves.toEqual(emptyRollup());
    // 也确认它真的没有把坏文件改写成别的东西（读路径不该有副作用）
    expect(await readFile(file, "utf8")).toBe("{ 这不是 JSON");
  });
});
