/** Native UsageDoc totals with bounded day/model journal projections.
 * Unretained dates remain in totals and model/kind breakdowns, outside calendar/streak metrics.
 */
import type { SessionKind } from "./session";

/** 四个互斥计费桶（与 SessionTokenUsage 同形，统计侧独立命名以免两处语义漂移） */
export interface UsageTokenBuckets {
  /** 未缓存输入（计费最贵的那一桶） */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/**
 * 一天的用量：热力图的一格、趋势图的一个采样点。
 * `date` 是**本地日**（YYYY-MM-DD）—— 连续天数、当日峰值这些概念都是用户所在时区的概念。
 */
export interface UsageDayPoint {
  date: string;
  /** 当天全部模型合计（口径见本文件头） */
  tokens: number;
  /**
   * 当天分模型合计，键是 `serviceId/modelId`（与 UsageModelPoint.key 同源）。
   * 值为 0 的模型不进这张表。
   */
  models: Record<string, number>;
}

/** 一个模型的累计用量（环形图 + 图例） */
export interface UsageModelPoint {
  /** `serviceId/modelId`；serviceId 被删掉时仍按原样保留，界面回落到只显示 modelId */
  key: string;
  serviceId: string;
  modelId: string;
  tokens: number;
  /** 占全部 token 的比例（0–1）；全部为 0 时是 0 */
  share: number;
}

/** 会话数与它们各自的 token 合计（按种类拆开，好向用户解释「这些 token 是哪来的」） */
export interface UsageSessionBreakdown {
  total: number;
  chat: { sessions: number; tokens: number };
  subagent: { sessions: number; tokens: number };
}

/** 历史折叠的进度：`active` 为真时界面说明「正在整理历史用量」并再问一次 */
export interface UsageScanProgress {
  active: boolean;
  /** 已折叠完成的会话数 / 需要看的会话总数（仅用于进度显示） */
  scanned: number;
  total: number;
}

/** 一次统计查询的完整结果 */
export interface UsageStatsReport {
  /** 生成时刻（epoch ms）：渲染层用它做「这份数据是什么时候的」的说明 */
  generatedAt: number;
  /** 今天（本地日 YYYY-MM-DD）：热力图窗口与连续天数都以它为锚，避免两处各算一次 */
  today: string;
  totals: UsageTokenBuckets;
  /** 全部计费桶之和 */
  totalTokens: number;
  /** Included in totals, excluded from the calendar because the date was not retained. */
  undatedTokens?: number;
  sessions: UsageSessionBreakdown;
  /** 有用量记录的天数 */
  activeDays: number;
  /** 单日峰值（token 最多的一天）；没有任何记录时 tokens 为 0、date 为 null */
  peak: { date: string | null; tokens: number };
  /** 最长的一次「聊天跨度」= 某会话首条到末条用量记录的时间差 */
  longestSession: { sessionId: string | null; title: string | null; ms: number };
  /**
   * 连续天数。`current` 的判定：今天有记录就从今天往回数，
   * 今天还没有记录就从昨天往回数 —— 一天还没过完不该把连续记录判为中断。
   */
  streak: { current: number; longest: number };
  /** 全部有记录的日子，按日期升序 */
  days: UsageDayPoint[];
  /** 全部用过量的模型，按 token 降序 */
  models: UsageModelPoint[];
  scanning: UsageScanProgress;
}

/** 会话种类 → 它落在哪个统计桶里；子智能体与普通会话按同一个口径计数 */
export function sessionKindOf(kind: SessionKind | undefined): SessionKind {
  return kind === "subagent" ? "subagent" : "chat";
}
