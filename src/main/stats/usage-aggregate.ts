/**
 * 卷账本 → 统计报告：纯函数，不碰磁盘也不碰 SQLite。
 *
 * 拆出来的理由：这一层承载的全部是**口径**（哪些天算活跃、连续天数怎么数、占比的分母是谁），
 * 而口径是最容易悄悄错的地方 —— 它必须能被单测直接驱动，不必先造一份真实会话日志。
 */
import type { SessionKind } from "@/shared/contracts/session";
import type {
  UsageDayPoint,
  UsageModelPoint,
  UsageScanProgress,
  UsageSessionBreakdown,
  UsageStatsReport,
  UsageTokenBuckets,
} from "@/shared/contracts/stats";
import { addDays, diffDays } from "@/shared/local-day";
import {
  bucketTotal,
  emptyBuckets,
  type RollupBuckets,
  splitModelKey,
  type UsageRollup,
} from "./usage-rollup";

/** 聚合输入里的会话元信息：标题给「最长聊天」用，kind 用来把子智能体的用量拆出来 */
export interface SessionMeta {
  title: string | null;
  kind: SessionKind;
}

export interface AggregateUsageInput {
  rollup: UsageRollup;
  /** 会话 id → 元信息；不在表里的会话（已被删掉）不计入会话数与种类拆分 */
  sessions: ReadonlyMap<string, SessionMeta>;
  /** 今天（本地日）；由调用方给，报告里的连续天数都以它为锚 */
  today: string;
  scanning: UsageScanProgress;
  now: number;
}

export function aggregateUsageReport(input: AggregateUsageInput): UsageStatsReport {
  const { rollup, sessions, today, scanning, now } = input;

  const totals = emptyBuckets();
  const dayTotals = new Map<string, RollupBuckets>();
  const dayModels = new Map<string, Map<string, RollupBuckets>>();
  const modelTotals = new Map<string, RollupBuckets>();
  const kindTokens: Record<SessionKind, number> = { chat: 0, subagent: 0 };
  let longest: { sessionId: string; ms: number } | null = null;

  for (const [sessionId, session] of Object.entries(rollup.sessions)) {
    const meta = sessions.get(sessionId);
    // 已被删掉的会话不参与：它的用量不该再出现在报告里
    //（正常路径上 pruneRollup 已经丢掉了它们，这里是「列表已更新、卷账本还没落盘」的兜底）
    if (meta === undefined) continue;

    const sessionBuckets = emptyBuckets();
    for (const [date, day] of Object.entries(session.days)) {
      addInto(sessionBuckets, day);
      addInto(totals, day);

      const merged = dayTotals.get(date) ?? emptyBuckets();
      addInto(merged, day);
      dayTotals.set(date, merged);

      const byModel = dayModels.get(date) ?? new Map<string, RollupBuckets>();
      for (const [modelKey, buckets] of Object.entries(day.m)) {
        const dayModel = byModel.get(modelKey) ?? emptyBuckets();
        addInto(dayModel, buckets);
        byModel.set(modelKey, dayModel);

        const modelTotal = modelTotals.get(modelKey) ?? emptyBuckets();
        addInto(modelTotal, buckets);
        modelTotals.set(modelKey, modelTotal);
      }
      dayModels.set(date, byModel);
    }

    kindTokens[meta.kind === "subagent" ? "subagent" : "chat"] += bucketTotal(sessionBuckets);

    if (session.first !== undefined && session.last !== undefined) {
      const ms = Math.max(0, session.last - session.first);
      if (longest === null || ms > longest.ms) longest = { sessionId, ms };
    }
  }

  const days: UsageDayPoint[] = [...dayTotals.entries()]
    .map(([date, buckets]) => ({
      date,
      tokens: bucketTotal(buckets),
      models: modelTokenMap(dayModels.get(date)),
    }))
    .filter((day) => day.tokens > 0)
    .sort((left, right) => (left.date < right.date ? -1 : 1));

  const totalTokens = bucketTotal(totals);
  const models: UsageModelPoint[] = [...modelTotals.entries()]
    .map(([key, buckets]) => {
      const { serviceId, modelId } = splitModelKey(key);
      const tokens = bucketTotal(buckets);
      return {
        key,
        serviceId,
        modelId,
        tokens,
        share: totalTokens > 0 ? tokens / totalTokens : 0,
      };
    })
    .filter((model) => model.tokens > 0)
    .sort((left, right) => right.tokens - left.tokens);

  const activeDates = days.map((day) => day.date);
  const peak = days.reduce<UsageDayPoint | null>(
    (best, day) => (best === null || day.tokens > best.tokens ? day : best),
    null,
  );

  return {
    generatedAt: now,
    today,
    totals: pickBuckets(totals),
    totalTokens,
    sessions: sessionBreakdown(sessions, kindTokens),
    activeDays: activeDates.length,
    peak: { date: peak?.date ?? null, tokens: peak?.tokens ?? 0 },
    longestSession: {
      sessionId: longest?.sessionId ?? null,
      title: longest === null ? null : (sessions.get(longest.sessionId)?.title ?? null),
      ms: longest?.ms ?? 0,
    },
    streak: { current: currentStreak(activeDates, today), longest: longestStreak(activeDates) },
    days,
    models,
    scanning,
  };
}

/** 把一份桶加进另一份（原地） */
function addInto(target: RollupBuckets, source: RollupBuckets): void {
  target.i += source.i;
  target.o += source.o;
  target.cr += source.cr;
  target.cw += source.cw;
}

/** 卷账本的短名桶 → 契约的具名桶 */
function pickBuckets(buckets: RollupBuckets): UsageTokenBuckets {
  return {
    inputTokens: buckets.i,
    outputTokens: buckets.o,
    cacheReadTokens: buckets.cr,
    cacheWriteTokens: buckets.cw,
  };
}

/** 某一天的分模型合计（0 值不进表：图例与配色只该看到真的用过的模型） */
function modelTokenMap(byModel: Map<string, RollupBuckets> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (byModel === undefined) return out;
  for (const [key, buckets] of byModel) {
    const tokens = bucketTotal(buckets);
    if (tokens > 0) out[key] = tokens;
  }
  return out;
}

/**
 * 会话数与 token 合计按种类拆开。
 *
 * 计数用**会话列表**（不是卷账本）：一个从没用过的会话也是一个会话，用户看到的总数
 * 应当与侧栏里的会话数对得上；而 token 只能来自卷账本。
 */
function sessionBreakdown(
  sessions: ReadonlyMap<string, SessionMeta>,
  kindTokens: Record<SessionKind, number>,
): UsageSessionBreakdown {
  let chatSessions = 0;
  let subagentSessions = 0;
  for (const meta of sessions.values()) {
    if (meta.kind === "subagent") subagentSessions += 1;
    else chatSessions += 1;
  }
  return {
    total: sessions.size,
    chat: { sessions: chatSessions, tokens: kindTokens.chat },
    subagent: { sessions: subagentSessions, tokens: kindTokens.subagent },
  };
}

/**
 * 当前连续天数。
 *
 * 起点是今天；**今天还没有记录时从昨天起算** —— 一天还没过完，把「连续」判为中断
 * 是在拿一条还不成立的事实下结论（用户晚上十点做统计，看到连续天数归零会以为丢了历史）。
 * 昨天也没有记录时连续天数才是 0。
 */
function currentStreak(activeDates: readonly string[], today: string): number {
  const active = new Set(activeDates);
  let cursor = active.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (active.has(cursor)) {
    count += 1;
    cursor = addDays(cursor, -1);
  }
  return count;
}

/** 历史最长连续天数：按日期升序扫一遍，相邻差 1 天就接上 */
function longestStreak(activeDates: readonly string[]): number {
  const sorted = [...activeDates].sort();
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of sorted) {
    const contiguous = previous !== null && diffDays(previous, date) === 1;
    run = contiguous ? run + 1 : 1;
    previous = date;
    if (run > best) best = run;
  }
  return best;
}
