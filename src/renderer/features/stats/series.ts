/**
 * 统计图表的**数据整形**与配色：纯函数，与 React 无关，因此可以单独跑单测。
 *
 * 三件事刻意放在这里而不是组件里：
 *   1. 口径（哪一段日期、每周怎么合、累计怎么算）—— 它们错了图表也画得出来；
 *   2. 配色（模型 → 数据色槽位）—— 同一张图里两条线不能撞色，跨图之间又要一致；
 *   3. 分组（模型太多时合成「其他」）—— 图例的取舍规则。
 *
 * 配色取自 `index.css` 的 `--chart-1..5`（数据色，chrome 不用），
 * 而类名写成字面量：Tailwind 是静态扫描的，拼出来的类名不会进产物。
 */

import type { UsageDayPoint, UsageModelPoint } from "@/shared/contracts/stats";
import { addDays, dayKeyToDate } from "@/shared/local-day";

export interface SeriesColor {
  /** SVG 描边（折线） */
  stroke: string;
  /** SVG 填充（环图分段） */
  fill: string;
  /** 圆点 / 小方块（图例） */
  dot: string;
}

export const SERIES_COLORS: readonly SeriesColor[] = [
  { stroke: "stroke-chart-1", fill: "fill-chart-1", dot: "bg-chart-1" },
  { stroke: "stroke-chart-2", fill: "fill-chart-2", dot: "bg-chart-2" },
  { stroke: "stroke-chart-3", fill: "fill-chart-3", dot: "bg-chart-3" },
  { stroke: "stroke-chart-4", fill: "fill-chart-4", dot: "bg-chart-4" },
  { stroke: "stroke-chart-5", fill: "fill-chart-5", dot: "bg-chart-5" },
];

/** 取第 index 个配色；超出色板长度后循环复用（同时上图例里最多也就 5 组） */
export function seriesColorAt(index: number): SeriesColor {
  const size = SERIES_COLORS.length;
  // 先取模再加一轮再取模：负数下标（-1 % 5 === -1）也能落到合法槽位上
  const slot = ((Math.trunc(index) % size) + size) % size;
  return SERIES_COLORS[slot] as SeriesColor;
}

/** 热力图的五档（0 = 没用过，4 = 最满） */
export const HEAT_LEVELS = 4;

/**
 * 一个数值落在第几档。
 *
 * 按**当期最大值**分档，而不是绝对阈值：每个人的量级差着几个数量级
 *（一天 2 万 token 与一天 2 亿 token 都是「用了一天」），固定阈值会让一部分人的热力图
 * 整片同色。所以档位是相对的，看的是「这一段时间里哪几天更重」。
 */
export function heatLevel(value: number, max: number, levels = HEAT_LEVELS): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(levels, Math.max(1, Math.ceil((value / max) * levels)));
}

/** 热力图的口径：每天 / 每周 / 累计 */
export type HeatMode = "daily" | "weekly" | "cumulative";

export interface HeatCell {
  /** 本地日 YYYY-MM-DD */
  date: string;
  /** 该格的值（口径由 mode 决定） */
  value: number;
}

/**
 * 按口径把每日用量摊成热力图的值。
 *
 * - `daily`：当天合计（没有记录的那天是 0）；
 * - `weekly`：**所在自然周**（周一起）的合计 —— 每格仍是一天，颜色说的是那一周；
 * - `cumulative`：到该日为止的累计（含窗口之外的历史，所以是真正的「累计」）。
 *
 * 后两种口径**要把值延续到没有记录的日期上**，这正是它们与「每日」的本质差别：
 *   · 累计视图里，昨天没用今天也没用，累计值并不因此归零，它就该是一条不回落的曲线；
 *   · 周视图里，同一周的七天是一个数，否则「这周用了多少」要靠颜色深浅自己拼。
 * 所以它们返回的是**从第一条记录（或窗口左端）到今天**的连续日期，而不是只返回有记录的那些天。
 *
 * 窗口裁剪由热力图自己按「最近一年」做（与 assistant-ui 的 heat-graph 同一口径：
 * 越界的点静默忽略，不报错），所以这里最多铺一年 + 一天的格子。
 */
export function heatCells(
  days: readonly UsageDayPoint[],
  mode: HeatMode,
  today: string,
): HeatCell[] {
  const sorted = [...days].sort((left, right) => (left.date < right.date ? -1 : 1));
  if (mode === "daily") return sorted.map((day) => ({ date: day.date, value: day.tokens }));

  const first = sorted[0];
  if (first === undefined) return [];
  // 铺格子的起点：第一条记录，但不早于热力图窗口（更早的格子画不出来）
  const windowStart = addDays(today, -(HEAT_WINDOW_DAYS - 1));
  let cursor = first.date < windowStart ? windowStart : first.date;

  if (mode === "weekly") {
    const weekTotals = new Map<string, number>();
    for (const day of sorted) {
      const weekStart = mondayOf(day.date);
      weekTotals.set(weekStart, (weekTotals.get(weekStart) ?? 0) + day.tokens);
    }
    const cells: HeatCell[] = [];
    while (cursor <= today) {
      cells.push({ date: cursor, value: weekTotals.get(mondayOf(cursor)) ?? 0 });
      cursor = addDays(cursor, 1);
    }
    return cells;
  }

  const cells: HeatCell[] = [];
  let running = 0;
  let index = 0;
  while (cursor <= today) {
    // 把「截止到这一天」的记录都加进来：起点早于窗口时，这里累加的就是窗口外的历史
    while (index < sorted.length && (sorted[index]?.date ?? "") <= cursor) {
      running += sorted[index]?.tokens ?? 0;
      index += 1;
    }
    cells.push({ date: cursor, value: running });
    cursor = addDays(cursor, 1);
  }
  return cells;
}

/** 热力图的窗口天数（53 周 × 7 天）：heatCells 铺格子时的上界，与 heat-graph.tsx 对齐 */
export const HEAT_WINDOW_DAYS = 53 * 7;

/** 该日期所在自然周的周一（热力图的列对齐口径） */
export function mondayOf(date: string): string {
  // getDay() 的 0 是周日，换算成「距周一几天」；日期键必须走本地解析（见 shared/local-day）
  const day = dayKeyToDate(date).getDay();
  const offset = (day + 6) % 7;
  return addDays(date, -offset);
}

/**
 * 从 `today` 往前数 `count` 天的连续日期（含今天）。
 *
 * 趋势图的横轴用它：范围里的每一天都要在轴上有一个位置，
 * 哪怕那天一条记录都没有（缺数据是 0，不是「这一天不存在」）。
 */
export function rangeDates(today: string, count: number): string[] {
  const dates: string[] = [];
  for (let index = count - 1; index >= 0; index -= 1) dates.push(addDays(today, -index));
  return dates;
}

export interface TrendSeries {
  key: string;
  /** 与 `dates` 一一对应的值；没有记录的日期是 0 */
  points: number[];
  colorIndex: number;
}

/**
 * 把每日分模型用量拆成「每个模型一条线」的时间序列。
 *
 * `modelKeys` 决定线的顺序与配色（调用方按总量降序给），没在列表里的模型不进图 ——
 * 它们已经在图例里被合成「其他」了，再画一条没名字的线只是噪声。
 */
export function trendSeries(
  days: readonly UsageDayPoint[],
  dates: readonly string[],
  modelKeys: readonly string[],
): TrendSeries[] {
  const byDate = new Map(days.map((day) => [day.date, day]));
  return modelKeys.map((key, index) => ({
    key,
    colorIndex: index,
    points: dates.map((date) => byDate.get(date)?.models[key] ?? 0),
  }));
}

/** 「其他」那一组的固定键：界面按它取 i18n 文案，不是模型名 */
export const OTHER_MODELS_KEY = "__other__";

export interface ModelLegendRow {
  key: string;
  tokens: number;
  /** 0–1 */
  share: number;
  /** 该行包含的模型键（「其他」那行会多于一个）；命名行只有一个 */
  members: string[];
  colorIndex: number;
}

/**
 * 模型图例：按总量降序，超出 `limit` 的尾部合成一行「其他」。
 *
 * 为什么要有上限：环图与图例是**一眼看懂比例**的东西，十几段细弧线谁也读不出来。
 * 而「其他」必须真的把那些模型的量加进去（而不是直接丢掉），否则占比之和不是 100%，
 * 用户会以为数字算错了。
 */
export function modelLegendRows(
  models: readonly UsageModelPoint[],
  limit: number,
): ModelLegendRow[] {
  const sorted = [...models].sort((left, right) => right.tokens - left.tokens);
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const rows: ModelLegendRow[] = head.map((model, index) => ({
    key: model.key,
    tokens: model.tokens,
    share: model.share,
    members: [model.key],
    colorIndex: index,
  }));
  if (tail.length > 0) {
    const tokens = tail.reduce((sum, model) => sum + model.tokens, 0);
    const share = tail.reduce((sum, model) => sum + model.share, 0);
    rows.push({
      key: OTHER_MODELS_KEY,
      tokens,
      share,
      members: tail.map((model) => model.key),
      colorIndex: head.length,
    });
  }
  return rows;
}

/**
 * 模型键 → 界面上显示的名字。
 *
 * 优先用设置里那份模型条目的名字（用户自己起的名字最贴近他的认知），
 * 其次模型 id，最后兜底成键本身 —— 服务被删掉之后统计里仍留着那些键，
 * 那时至少还能看见模型 id，而不是一行空白。
 */
export function modelLabel(
  key: string,
  lookup: (serviceId: string, modelId: string) => string | null,
): string {
  if (key === OTHER_MODELS_KEY) return key;
  const at = key.indexOf("|");
  const serviceId = at === -1 ? "" : key.slice(0, at);
  const modelId = at === -1 ? key : key.slice(at + 1);
  return lookup(serviceId, modelId) ?? (modelId === "" ? key : modelId);
}
