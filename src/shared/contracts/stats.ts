/**
 * 用量统计（数据统计模态窗）的对外契约。
 *
 * ## 数据从哪来
 *
 * **不是**新建一份「用量账本」另起炉灶，而是把**已有的会话日志**（pi 的 SQLite 条目）
 * 增量折叠成一份按「本地日 × 模型」分桶的卷账本（rollup，见 main/stats/usage-rollup.ts）。
 * 理由：助手消息条目里本来就带着 `timestamp` / `provider` / `model` / `usage` 四样东西，
 * 它们才是这台机器上真实发生过的用量；而按会话聚合的 `SessionUsageRecord` 只有总量、
 * 没有时间与模型维度，也没有「跨重启仍然完整」的保证（见 runtime 的 persistUsage）。
 *
 * 折叠是**增量**的：每个会话记一个「已扫到的条目 seq」，重启后只扫新增的那一段。
 *
 * ## 口径
 *
 * `tokens` 一律 = 未缓存输入 + 缓存读取 + 缓存写入 + 输出（与底栏用量胶囊、
 * DSH 的 billedInputTokens 同口径），也就是**模型实际处理的全部 token**，
 * 而不是「只算新内容」的那种压缩口径。
 *
 * ## 为什么整份报告一次返回
 *
 * 时间范围（近 7 日 / 近 30 日）是**渲染层的视图状态**：报告里带着全部有记录的日子，
 * 切换范围只是换个切片，不必再走一次 IPC、也不会在切换时闪一下。
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
