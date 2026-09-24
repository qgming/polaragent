/**
 * 用量卷账本（rollup）：把会话日志里的逐条用量样本折叠成「会话 × 本地日 × 模型」的四桶计数。
 *
 * ## 为什么是卷账本而不是事件账本
 *
 * 真实数据已经在会话日志里了（助手消息条目带 timestamp / provider / model / usage），
 * 再存一份「每次调用一条」的事件流等于把同一件事记两遍 —— 两遍就会不一致，
 * 而不一致时没人知道该信哪一份。所以这里只存**折叠结果**，并按会话记一个
 * 「已折叠到的条目 seq」做增量游标：重启后不必重扫历史，会话删除时整条丢掉即可。
 *
 * ## 为什么按会话分桶，而不是直接按日合在一起
 *
 * 会话是可以被删掉的。按日合并之后，删会话就没有办法把那部分用量从某一天里减掉，
 * 只能整表重扫。按会话分桶让「删除」退化成「丢掉一个键」，而日视图是一次求和。
 *
 * ## 数据文件
 *
 * `<数据根>/usage-stats.json`，与 sessions-index.json 同级：它是**派生数据**，
 * 坏了可以整份删掉重扫（下一次打开统计就重建），所以解析失败时一律回退空账本，绝不抛错。
 * 文件里字段名是短名（i/o/cr/cw）：一年下来这份表会有上千个键，长名纯粹是体积。
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UsageSample } from "@/main/pisdk/session-store";
import { writeFileAtomic } from "@/main/storage/atomic-write";
import { dayKeyOf } from "@/shared/local-day";

/** 四个互斥计费桶的卷账本形态（对应契约的 UsageTokenBuckets） */
export interface RollupBuckets {
  i: number;
  o: number;
  cr: number;
  cw: number;
}

/** 某会话某一天的用量；`m` 是按模型拆的同一组桶 */
export interface RollupDay extends RollupBuckets {
  m: Record<string, RollupBuckets>;
}

export interface RollupSession {
  /** 该会话最早/最晚一条用量样本的时间（「最长聊天时长」用它算跨度） */
  first?: number;
  last?: number;
  /** 已折叠到的条目 seq：下次只取严格大于它的条目 */
  seq: number;
  /**
   * 折叠时该会话的 updatedAt 快照。会话列表里的 updatedAt 没超过它就**跳过开库** ——
   * 稳态下一次统计查询因此完全不碰 SQLite（118 个会话实测省下约 270ms 的同步阻塞）。
   */
  seenUpdatedAt: number;
  days: Record<string, RollupDay>;
}

export interface UsageRollup {
  /** 卷账本自身的版本；将来改形状时据此决定「重扫」而不是「读坏数据」 */
  version: number;
  sessions: Record<string, RollupSession>;
}

export const ROLLUP_VERSION = 1;

export function emptyRollup(): UsageRollup {
  return { version: ROLLUP_VERSION, sessions: {} };
}

/**
 * 一条用量样本：会话日志里一条带 usage 的助手消息。
 *
 * 形状由**会话库**定义（它是唯一的读取方，见 session-store 的 UsageSample），
 * 这里只做转出，统计侧与扫描侧因此共用同一个类型而不用再造一份。
 */
export type { UsageSample };

/**
 * 模型键：`serviceId|modelId`。
 *
 * 分隔符用 `|` 而不是 `/`：模型 id 里**可能**带斜杠（目录 id 就是 `deepseek/deepseek-v4-flash`
 * 那种形状），用斜杠拼键会让「服务是哪一段」变成猜的；UUID 型的 serviceId 一定不含 `|`。
 * 缺 serviceId 时只留 modelId（旧条目、或用户删掉了服务配置）。
 */
export function modelKeyOf(serviceId: string | undefined, modelId: string | undefined): string {
  const service = serviceId?.trim() ?? "";
  const model = modelId?.trim() ?? "";
  if (model === "") return "unknown";
  return service === "" ? model : `${service}|${model}`;
}

/** 模型键拆回两段（服务 id 被删掉后，界面至少还能显示 modelId） */
export function splitModelKey(key: string): { serviceId: string; modelId: string } {
  const at = key.indexOf("|");
  if (at === -1) return { serviceId: "", modelId: key };
  return { serviceId: key.slice(0, at), modelId: key.slice(at + 1) };
}

/** 四个桶之和：统计口径 = 模型实际处理的全部 token（与底栏用量胶囊同口径） */
export function bucketTotal(buckets: RollupBuckets): number {
  return buckets.i + buckets.o + buckets.cr + buckets.cw;
}

export function emptyBuckets(): RollupBuckets {
  return { i: 0, o: 0, cr: 0, cw: 0 };
}

/** 样本里的四个桶是否全为 0（供应商没上报用量的那条消息不该在统计里占一天） */
export function isZeroSample(sample: UsageSample): boolean {
  return (
    sample.inputTokens + sample.outputTokens + sample.cacheReadTokens + sample.cacheWriteTokens ===
    0
  );
}

/**
 * 把一个会话的新样本折进它的账本条目（纯函数，返回新对象）。
 *
 * 时间戳取 min/max 而不是「首条/末条」：条目顺序理论上就是时间顺序，但 fork 出来的
 * 会话会把父会话的条目一并复制过来，那时**扫描顺序与实际时间顺序不再一致**，
 * 按顺序取值会把跨度算成负的或严重偏小。
 *
 * `since` 是「早于这个时刻的样本不收」的下界（调用方传会话创建时间）：
 * fork 复制过来的历史条目全靠它排除，否则每 fork 一次就把之前的历史重复计一遍。
 * 不传表示不过滤。
 */
export function applyUsageSamples(
  session: RollupSession,
  samples: readonly UsageSample[],
  since?: number,
): RollupSession {
  if (samples.length === 0) return session;
  const days: Record<string, RollupDay> = { ...session.days };
  let first = session.first;
  let last = session.last;

  for (const sample of samples) {
    if (isZeroSample(sample)) continue;
    if (since !== undefined && sample.at < since) continue;
    const modelKey = modelKeyOf(sample.serviceId, sample.modelId);
    const key = dayKeyOf(sample.at);
    const day = days[key] ?? { i: 0, o: 0, cr: 0, cw: 0, m: {} };
    const model = day.m[modelKey] ?? emptyBuckets();
    days[key] = {
      i: day.i + sample.inputTokens,
      o: day.o + sample.outputTokens,
      cr: day.cr + sample.cacheReadTokens,
      cw: day.cw + sample.cacheWriteTokens,
      m: {
        ...day.m,
        [modelKey]: {
          i: model.i + sample.inputTokens,
          o: model.o + sample.outputTokens,
          cr: model.cr + sample.cacheReadTokens,
          cw: model.cw + sample.cacheWriteTokens,
        },
      },
    };
    if (first === undefined || sample.at < first) first = sample.at;
    if (last === undefined || sample.at > last) last = sample.at;
  }

  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    seq: session.seq,
    seenUpdatedAt: session.seenUpdatedAt,
    days,
  };
}

/**
 * 丢掉已经不存在于会话列表里的会话条目。
 *
 * `keepEmpty` 是**必须的护栏**：会话列表读取失败时 store.list() 返回空数组（见它的注释），
 * 那时若照常裁剪，一次磁盘抖动就会把整份历史用量抹掉 —— 而重扫回来要几秒钟，
 * 用户看到的是「统计数据突然归零」。
 */
export function pruneRollup(rollup: UsageRollup, keep: ReadonlySet<string>): UsageRollup {
  if (keep.size === 0) return rollup;
  const sessions: Record<string, RollupSession> = {};
  let changed = false;
  for (const [id, session] of Object.entries(rollup.sessions)) {
    if (keep.has(id)) sessions[id] = session;
    else changed = true;
  }
  return changed ? { version: rollup.version, sessions } : rollup;
}

/** 解析磁盘上的卷账本；认不出的形状一律跳过，整体不可解析时回退空账本 */
export function parseRollup(raw: unknown): UsageRollup {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return emptyRollup();
  const record = raw as Record<string, unknown>;
  const rawSessions = record.sessions;
  if (typeof rawSessions !== "object" || rawSessions === null || Array.isArray(rawSessions)) {
    return emptyRollup();
  }
  const sessions: Record<string, RollupSession> = {};
  for (const [id, value] of Object.entries(rawSessions as Record<string, unknown>)) {
    const session = parseRollupSession(value);
    if (session !== undefined) sessions[id] = session;
  }
  const version = typeof record.version === "number" ? record.version : ROLLUP_VERSION;
  // 版本不认识：整份作废重扫，而不是拿一份可能语义不同的数据继续算
  if (version !== ROLLUP_VERSION) return emptyRollup();
  return { version, sessions };
}

function parseRollupSession(raw: unknown): RollupSession | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const seq = finite(record.seq) ?? 0;
  const daysRaw = record.days;
  if (typeof daysRaw !== "object" || daysRaw === null || Array.isArray(daysRaw)) return undefined;
  const days: Record<string, RollupDay> = {};
  for (const [key, value] of Object.entries(daysRaw as Record<string, unknown>)) {
    const day = parseRollupDay(value);
    if (day !== undefined) days[key] = day;
  }
  const first = finite(record.first);
  const last = finite(record.last);
  return {
    ...(first === undefined ? {} : { first }),
    ...(last === undefined ? {} : { last }),
    seq,
    seenUpdatedAt: finite(record.seenUpdatedAt) ?? 0,
    days,
  };
}

function parseRollupDay(raw: unknown): RollupDay | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const models: Record<string, RollupBuckets> = {};
  const modelsRaw = record.m;
  if (typeof modelsRaw === "object" && modelsRaw !== null && !Array.isArray(modelsRaw)) {
    for (const [key, value] of Object.entries(modelsRaw as Record<string, unknown>)) {
      const buckets = parseBuckets(value);
      if (buckets !== undefined) models[key] = buckets;
    }
  }
  return {
    i: finite(record.i) ?? 0,
    o: finite(record.o) ?? 0,
    cr: finite(record.cr) ?? 0,
    cw: finite(record.cw) ?? 0,
    m: models,
  };
}

function parseBuckets(raw: unknown): RollupBuckets | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  return {
    i: finite(record.i) ?? 0,
    o: finite(record.o) ?? 0,
    cr: finite(record.cr) ?? 0,
    cw: finite(record.cw) ?? 0,
  };
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 读卷账本；文件缺失或损坏都回退空账本（下次统计会重建） */
export async function readRollupFile(filePath: string): Promise<UsageRollup> {
  try {
    return parseRollup(JSON.parse(await readFile(filePath, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`读取用量统计失败，将重建: ${String(error)}`);
    }
    return emptyRollup();
  }
}

/** 写卷账本（原子写：中断不会留下半截 JSON） */
export async function writeRollupFile(filePath: string, rollup: UsageRollup): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFileAtomic(filePath, `${JSON.stringify(rollup)}\n`);
}

/** 卷账本在数据根下的位置 */
export function rollupFilePath(dataDir: string): string {
  return path.join(dataDir, "usage-stats.json");
}
