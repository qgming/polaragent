import { describe, expect, it } from "vitest";
import type { UsageDayPoint, UsageModelPoint } from "@/shared/contracts/stats";
import {
  heatCells,
  heatLevel,
  modelLabel,
  modelLegendRows,
  mondayOf,
  OTHER_MODELS_KEY,
  rangeDates,
  seriesColorAt,
  trendSeries,
} from "./series";

/** 造一天的数据：`{ "2026-09-24": { total: 100, models: { m1: 60 } } }` */
function day(date: string, total: number, models: Record<string, number> = {}): UsageDayPoint {
  return { date, tokens: total, models };
}

function model(key: string, tokens: number, share = 0): UsageModelPoint {
  const [serviceId, modelId] = key.split("|");
  return { key, serviceId: serviceId ?? "", modelId: modelId ?? "", tokens, share };
}

describe("heatLevel", () => {
  it("0 与负值是第 0 档（空槽）", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(-5, 100)).toBe(0);
  });

  it("按当期最大值分四档，有值就不会落回 0 档", () => {
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(25, 100)).toBe(1);
    expect(heatLevel(26, 100)).toBe(2);
    expect(heatLevel(100, 100)).toBe(4);
  });

  it("最大值为 0（一段全空的历史）时不除零", () => {
    expect(heatLevel(10, 0)).toBe(0);
  });
});

describe("mondayOf", () => {
  it("一周内的每天都归到同一个周一", () => {
    // 2026-09-21 是周一
    expect(mondayOf("2026-09-21")).toBe("2026-09-21");
    expect(mondayOf("2026-09-24")).toBe("2026-09-21");
    expect(mondayOf("2026-09-27")).toBe("2026-09-21");
  });

  it("跨月的周日归到上个月的周一", () => {
    // 2026-10-01 是周四 -> 该周周一在 9 月
    expect(mondayOf("2026-10-01")).toBe("2026-09-28");
    expect(mondayOf("2026-10-04")).toBe("2026-09-28");
  });
});

describe("heatCells", () => {
  const days = [day("2026-09-21", 10), day("2026-09-22", 20), day("2026-09-28", 30)];
  const TODAY = "2026-09-29";

  it("daily：每天自己的量，只有有记录的日子才有格子", () => {
    expect(heatCells(days, "daily", TODAY)).toEqual([
      { date: "2026-09-21", value: 10 },
      { date: "2026-09-22", value: 20 },
      { date: "2026-09-28", value: 30 },
    ]);
  });

  /**
   * 周视图与累计视图都要**把值延续到没有记录的日期上**：
   * 本周还有几天没记录，不代表「这周的量」在那几天变成 0；累计更是不能回落到 0
   * （否则图上会出现一条冲到顶又掉回零的曲线，那是在撒谎）。
   */
  it("weekly：同一自然周（周一起）的合计，延续到那一周的每一天", () => {
    const cells = heatCells(days, "weekly", TODAY);
    const heatValue = (date: string) => cells.find((cell) => cell.date === date)?.value;
    expect(heatValue("2026-09-21")).toBe(30);
    expect(heatValue("2026-09-22")).toBe(30);
    // 09-23 没有记录，但它与 21/22 同属一周：值仍应是该周合计
    expect(heatValue("2026-09-23")).toBe(30);
    // 09-27 是那一周的周日
    expect(heatValue("2026-09-27")).toBe(30);
    // 09-28 起是新的一周
    expect(heatValue("2026-09-28")).toBe(30);
    expect(heatValue("2026-09-29")).toBe(30);
  });

  it("cumulative：到该日为止的累计，单调不减且延续到今天", () => {
    const cells = heatCells(days, "cumulative", TODAY);
    expect(cells[0]).toEqual({ date: "2026-09-21", value: 10 });
    expect(cells.find((cell) => cell.date === "2026-09-22")?.value).toBe(30);
    // 没有记录的那几天，累计值保持不变（不是 0）
    expect(cells.find((cell) => cell.date === "2026-09-23")?.value).toBe(30);
    expect(cells.find((cell) => cell.date === "2026-09-28")?.value).toBe(60);
    expect(cells[cells.length - 1]).toEqual({ date: TODAY, value: 60 });
    const values = cells.map((cell) => cell.value);
    expect([...values].sort((left, right) => left - right)).toEqual(values);
  });

  it("铺格子的范围止于今天（不画出未来的格子）", () => {
    const cells = heatCells(days, "cumulative", TODAY);
    expect(cells.every((cell) => cell.date <= TODAY)).toBe(true);
    expect(cells).toHaveLength(9); // 09-21 .. 09-29
  });

  it("铺格子不超过热力图窗口（更早的历史只体现在累计值里）", () => {
    const longAgo = [day("2020-01-01", 100), day(TODAY, 5)];
    const cells = heatCells(longAgo, "cumulative", TODAY);
    expect(cells.length).toBeLessThanOrEqual(371);
    // 窗口外的历史仍然计入累计值
    expect(cells[cells.length - 1]?.value).toBe(105);
  });

  it("乱序输入先排序（报告理论上已排好，但口径不该依赖调用方）", () => {
    const shuffled = [day("2026-09-28", 30), day("2026-09-21", 10)];
    const values = heatCells(shuffled, "cumulative", TODAY).map((cell) => cell.value);
    expect(values[0]).toBe(10);
    expect(values[values.length - 1]).toBe(40);
  });

  it("没有任何记录时给空表（界面走空态）", () => {
    expect(heatCells([], "weekly", TODAY)).toEqual([]);
    expect(heatCells([], "cumulative", TODAY)).toEqual([]);
    expect(heatCells([], "daily", TODAY)).toEqual([]);
  });
});

describe("rangeDates", () => {
  it("含今天在内、往前连续 N 天，升序", () => {
    expect(rangeDates("2026-09-24", 3)).toEqual(["2026-09-22", "2026-09-23", "2026-09-24"]);
  });

  it("跨月也连续", () => {
    expect(rangeDates("2026-10-02", 4)).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
  });
});

describe("trendSeries", () => {
  it("只画点名要的模型，缺数据的日期补 0", () => {
    const days = [
      day("2026-09-23", 10, { "s|a": 10 }),
      day("2026-09-24", 30, { "s|a": 20, "s|b": 10 }),
    ];
    const series = trendSeries(days, ["2026-09-22", "2026-09-23", "2026-09-24"], ["s|a", "s|b"]);
    expect(series).toEqual([
      { key: "s|a", colorIndex: 0, points: [0, 10, 20] },
      { key: "s|b", colorIndex: 1, points: [0, 0, 10] },
    ]);
  });

  it("范围里完全没有记录的日期是 0，不是缺失", () => {
    expect(trendSeries([], ["2026-09-24"], ["s|a"])).toEqual([
      { key: "s|a", colorIndex: 0, points: [0] },
    ]);
  });
});

describe("modelLegendRows", () => {
  const models = [
    model("s|a", 80, 0.8),
    model("s|b", 10, 0.1),
    model("s|c", 6, 0.06),
    model("s|d", 4, 0.04),
  ];

  it("按用量降序，未超上限时原样给出", () => {
    const rows = modelLegendRows(models, 4);
    expect(rows.map((row) => row.key)).toEqual(["s|a", "s|b", "s|c", "s|d"]);
    expect(rows.map((row) => row.colorIndex)).toEqual([0, 1, 2, 3]);
  });

  it("超出上限的尾部合成「其他」，token 与占比都要加进去（否则占比和不是 100%）", () => {
    const rows = modelLegendRows(models, 2);
    expect(rows.map((row) => row.key)).toEqual(["s|a", "s|b", OTHER_MODELS_KEY]);
    const other = rows[2];
    expect(other?.tokens).toBe(10);
    expect(other?.share).toBeCloseTo(0.1);
    expect(other?.members).toEqual(["s|c", "s|d"]);
    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(100);
    expect(rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1);
  });

  it("不修改入参顺序（报告的顺序是降序，但调用方可能给了别的）", () => {
    const shuffled = [model("s|b", 10, 0.1), model("s|a", 90, 0.9)];
    modelLegendRows(shuffled, 4);
    expect(shuffled.map((entry) => entry.key)).toEqual(["s|b", "s|a"]);
  });

  it("没有模型时是空表（界面走空态）", () => {
    expect(modelLegendRows([], 4)).toEqual([]);
  });
});

describe("modelLabel", () => {
  it("优先用设置里的名字", () => {
    expect(modelLabel("svc|deepseek-chat", () => "DeepSeek Chat")).toBe("DeepSeek Chat");
  });

  it("设置里查不到时回落到模型 id（服务被删掉的历史记录）", () => {
    expect(modelLabel("svc|deepseek-chat", () => null)).toBe("deepseek-chat");
    expect(modelLabel("orphan-model", () => null)).toBe("orphan-model");
  });

  it("「其他」那一行原样返回键，由调用方换成词条", () => {
    expect(modelLabel(OTHER_MODELS_KEY, () => "不该被调用")).toBe(OTHER_MODELS_KEY);
  });
});

describe("seriesColorAt", () => {
  it("五个色槽循环复用，绝不越界", () => {
    expect(seriesColorAt(0).stroke).toBe("stroke-chart-1");
    expect(seriesColorAt(4).stroke).toBe("stroke-chart-5");
    expect(seriesColorAt(5).stroke).toBe("stroke-chart-1");
    expect(seriesColorAt(-1).stroke).toBe("stroke-chart-5");
  });

  it("配色是数据色（chart-*），不是强调色", () => {
    for (const color of [seriesColorAt(0), seriesColorAt(3)]) {
      expect(color.stroke.startsWith("stroke-chart-")).toBe(true);
      expect(color.dot.startsWith("bg-chart-")).toBe(true);
    }
  });
});
