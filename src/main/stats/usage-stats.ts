/**
 * 用量统计服务：把「会话日志 → 卷账本 → 报告」这条链收口成一个按需调用的入口。
 *
 * ## 为什么是按需（打开模态窗时）而不是启动时预热
 *
 * 折叠历史要打开每一个会话的 SQLite（底层是同步驱动，本机 118 个会话实测约 1.2s）。
 * 启动时做这件事，用户会先看到一次无来由的卡顿；按需做，它只发生在用户主动点开统计
 * 的那一次，而那次本来就有加载态可以承载。
 *
 * ## 增量与预算
 *
 * 每个会话记着「已折叠到的条目 seq」与「折叠时的 updatedAt 快照」。稳态下
 * （没有新消息）整次查询**一个 SQLite 都不开**，只做一次纯计算；有新消息的会话才开库，
 * 且每次请求有预算（会话数 × 条目数），预算用尽就带着 `scanning.active = true` 返回，
 * 界面据此再问一次。历史因此是**分几拍**整理完的，而不是把主进程按在地上几秒。
 *
 * ## 单例与并发
 *
 * 并发请求（用户连点两下）共用同一次进行中的折叠 —— 否则两次折叠会各自从同一个游标
 * 出发、把同一批样本算两遍。
 */
import { dataDir } from "@/main/app/paths";
import { getSessionStore, type SessionStore } from "@/main/pisdk/session-store";
import type { UsageScanProgress, UsageStatsReport } from "@/shared/contracts/stats";
import { dayKeyOf } from "@/shared/local-day";
import { aggregateUsageReport, type SessionMeta } from "./usage-aggregate";
import {
  applyUsageSamples,
  pruneRollup,
  type RollupSession,
  readRollupFile,
  rollupFilePath,
  type UsageRollup,
  writeRollupFile,
} from "./usage-rollup";

/**
 * 一次请求的预算。
 *
 * 会话数不是主要成本（开库约 2–3ms），**条目数**才是（读 + 解析 JSON）。
 * 两个预算一起用：本机 118 个会话全开完约 1.2s，首屏因此等不了太久，
 * 但用户的历史可以比这大得多，所以仍然分批 —— 前几拍几十毫秒就能出数，
 * 剩下的在「正在整理历史用量」里继续。
 */
const SESSION_BUDGET = 24;
const ENTRY_BUDGET = 6_000;

/**
 * fork 出来的会话会把父会话的条目**原样复制**一份（时间戳、用量都一样）。
 * 那些条目在复制的那一刻并没有真的再花一次 token，统计里必须排除，
 * 否则每 fork 一次就把之前的历史重复计一遍。
 *
 * 判据：复制过来的条目时间戳早于本会话的创建时间（正常消息一定晚于会话创建）。
 * 留一分钟余量是给时钟抖动与「会话先建、首条消息几乎同时落盘」这种边界，
 * 不至于把真实的首条消息误判成复制品。
 */
const FORK_COPY_SLACK_MS = 60_000;

export interface UsageStatsService {
  report(): Promise<UsageStatsReport>;
}

export interface UsageStatsDeps {
  store: SessionStore;
  /** 卷账本文件（默认：数据根下的 usage-stats.json） */
  filePath: string;
  now?: () => number;
}

export function createUsageStatsService(deps: UsageStatsDeps): UsageStatsService {
  const now = deps.now ?? (() => Date.now());
  /** 内存里的卷账本：第一次查询时从磁盘读入，之后作为唯一真源 */
  let rollup: UsageRollup | null = null;
  /** 读盘只做一次；并发首次查询共享同一个 Promise */
  let loading: Promise<UsageRollup> | null = null;
  /** 进行中的折叠：并发请求复用它 */
  let inFlight: Promise<UsageStatsReport> | null = null;

  /**
   * 取当前卷账本：内存里有一份就用它，否则从磁盘读一次。
   *
   * ⚠️ 不能写成「`loading` 这个 Promise 只建一次、之后直接 await 它」——
   * Promise 记住的是**第一次解析出来的那个对象**，于是每次折叠都从同一份初始状态出发：
   * 游标推进了、报告却看不出进展，表现为「正在整理历史用量」永远转不完
   *（真实数据上实测过：20 轮之后仍停在 48/118）。这里每次都返回 `rollup` 本身。
   */
  async function load(): Promise<UsageRollup> {
    if (rollup !== null) return rollup;
    loading ??= readRollupFile(deps.filePath);
    const loaded = await loading;
    rollup ??= loaded;
    return rollup;
  }

  async function scan(): Promise<UsageStatsReport> {
    const store = deps.store;
    const state = await load();
    const summaries = await store.list();

    /*
      会话列表读失败时 store.list() 返回空数组（见它的实现）。那种情况下**不能**当成
      「用户没有任何会话」：报告会显示成一片 0，用户以为历史丢了。抛错让界面显示
      失败态与重试按钮，比给一份假数据诚实。
    */
    if (summaries.length === 0 && Object.keys(state.sessions).length > 0) {
      throw new Error("读取会话列表失败");
    }

    const keep = new Set(summaries.map((summary) => summary.id));
    // 已删除的会话从账本里摘掉（keep 为空时 pruneRollup 内部不动手，见它的注释）
    const pruned = pruneRollup(state, keep);
    const sessions: Record<string, RollupSession> = { ...pruned.sessions };

    const metaById = new Map<string, SessionMeta>(
      summaries.map((summary) => [
        summary.id,
        { title: summary.title, kind: summary.kind ?? "chat" },
      ]),
    );

    /** 需要折叠的会话：没扫过，或上次折叠之后 updatedAt 又变过 */
    const pending = summaries.filter((summary) => {
      const entry = sessions[summary.id];
      return entry === undefined || entry.seenUpdatedAt < summary.updatedAt;
    });

    let sessionBudget = SESSION_BUDGET;
    let entryBudget = ENTRY_BUDGET;
    let scannedCount = summaries.length - pending.length;
    let changed = pruned !== state;

    for (const summary of pending) {
      if (sessionBudget <= 0 || entryBudget <= 0) break;
      sessionBudget -= 1;
      const previous = sessions[summary.id];
      const result = await store.scanUsageSamples(summary.id, previous?.seq ?? 0, entryBudget);
      entryBudget -= result.entries;

      const base: RollupSession = previous ?? { seq: 0, seenUpdatedAt: 0, days: {} };
      const folded = applyUsageSamples(
        base,
        result.samples,
        summary.createdAt - FORK_COPY_SLACK_MS,
      );
      sessions[summary.id] = {
        ...folded,
        seq: result.nextSeq,
        // 还有条目没扫完时**不**记 updatedAt 快照：这个会话下次仍算待折叠，
        // 但游标已经推进，接着扫的是下一段
        seenUpdatedAt: result.done ? summary.updatedAt : base.seenUpdatedAt,
      };
      changed = true;
      if (result.done) scannedCount += 1;
    }

    const next: UsageRollup = { version: state.version, sessions };
    if (changed) {
      rollup = next;
      /*
        落盘**等它写完**再应答：这份文件是下次启动的唯一依据，而写入本身只有几毫秒
        （几 KB 的原子写）。不等的话，「刚统计完就重启」会丢掉这一轮 ——
        用户看到的是"数字又回去了"。写失败只告警：内存里的账本仍然有效，
        这一次的报告照常给出。
      */
      try {
        await writeRollupFile(deps.filePath, next);
      } catch (error) {
        console.warn(`保存用量统计失败: ${String(error)}`);
      }
    }

    const remaining = summaries.filter((summary) => {
      const entry = sessions[summary.id];
      return entry === undefined || entry.seenUpdatedAt < summary.updatedAt;
    }).length;

    const progress: UsageScanProgress = {
      active: remaining > 0,
      scanned: scannedCount,
      total: summaries.length,
    };

    return aggregateUsageReport({
      rollup: next,
      sessions: metaById,
      today: dayKeyOf(now()),
      scanning: progress,
      now: now(),
    });
  }

  return {
    report: () => {
      inFlight ??= scan().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

let defaultService: UsageStatsService | null = null;

/** 默认单例：卷账本位于数据根（~/.oint 或 OINT_HOME），会话数据取自会话库单例 */
export function getUsageStatsService(): UsageStatsService {
  defaultService ??= createUsageStatsService({
    store: getSessionStore(),
    filePath: rollupFilePath(dataDir()),
  });
  return defaultService;
}
