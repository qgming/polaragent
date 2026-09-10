// models.dev 模型元数据目录：拉取、缓存与按模型 ID 匹配。
// 纯解析/匹配逻辑与网络、磁盘部分分离，便于单元测试且不触发真实请求。

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { ipcMain, net } from "electron";
import { dataDir } from "@/main/app/paths";
import { IPC } from "@/shared/contracts/ipc";
import type { ModelCatalogEntry, ModelLookupResult } from "@/shared/contracts/models";

/** models.dev 全量目录地址 */
const CATALOG_URL = "https://models.dev/models.json";
/** 缓存有效期：24 小时（以缓存文件 mtime 计算） */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次网络请求超时 */
const FETCH_TIMEOUT_MS = 15000;
/** 拉取失败后的重试冷却，避免频繁打网络 */
const REFRESH_RETRY_MS = 5 * 60 * 1000;
/** limit 字段缺失时的兜底值 */
const FALLBACK_CONTEXT_WINDOW = 128000;
const FALLBACK_MAX_TOKENS = 8192;

/** 仅接受有限正数，其余（undefined/NaN/0/负数）视为缺失 */
function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 从 modalities.input 里只保留 text/image，去重；为空时兜底 ["text"] */
function extractInput(modalities: unknown): ("text" | "image")[] {
  if (typeof modalities !== "object" || modalities === null) return ["text"];
  const raw = (modalities as { input?: unknown }).input;
  if (!Array.isArray(raw)) return ["text"];
  const allowed = raw.filter(
    (item): item is "text" | "image" => item === "text" || item === "image",
  );
  const unique = [...new Set(allowed)];
  return unique.length > 0 ? unique : ["text"];
}

/**
 * 解析单条 models.dev 原始条目；缺 id/name 返回 null。
 * limit 缺失或非法时用兜底值，保证产物始终满足 ModelEntry。
 */
export function toCatalogEntry(raw: unknown): ModelCatalogEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (id === "" || name === "") return null;

  const limit =
    typeof record.limit === "object" && record.limit !== null
      ? (record.limit as Record<string, unknown>)
      : {};
  return {
    catalogId: id,
    name,
    contextWindow: toPositiveNumber(limit.context) ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: toPositiveNumber(limit.output) ?? FALLBACK_MAX_TOKENS,
    reasoning: record.reasoning === true,
    input: extractInput(record.modalities),
  };
}

/** 构建索引：key 为小写 catalogId */
export function buildCatalogIndex(entries: ModelCatalogEntry[]): Map<string, ModelCatalogEntry> {
  const index = new Map<string, ModelCatalogEntry>();
  for (const entry of entries) index.set(entry.catalogId.toLowerCase(), entry);
  return index;
}

/** 去掉 provider 前缀（首个 "/" 之前的部分），小写化 */
function modelTail(catalogId: string): string {
  const lower = catalogId.toLowerCase();
  const slash = lower.indexOf("/");
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** 最后一段：处理 openrouter/anthropic/claude-sonnet-4 这类多级 id */
function modelLastSegment(catalogId: string): string {
  const lower = catalogId.toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash >= 0 ? lower.slice(slash + 1) : lower;
}

/** 归一化用于模糊比较：去掉非字母数字字符（连字符、点、下划线、空格等） */
function normalizeForFuzzy(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 模糊打分：分数越高越"可能是同一个模型"；0 表示不够相似，直接放弃。
 * 依次考虑：归一化相等 → 尾部包含 → 词元重叠比例。
 */
function fuzzyScore(catalogId: string, needle: string): number {
  const candidates = [modelTail(catalogId), modelLastSegment(catalogId)];
  const target = normalizeForFuzzy(needle);
  const source = normalizeForFuzzy(modelTail(catalogId));
  if (source === "" || target === "") return 0;

  let best = 0;
  for (const candidate of candidates) {
    const normalized = normalizeForFuzzy(candidate);
    if (normalized === "") continue;
    // 1) 归一化后完全一致（deepseek-v4.1-flash 与 deepseek-v4-1-flash）
    if (normalized === target) return 1000;
    // 2) 尾部包含，且长度接近才认为可靠，避免 "chat" 命中一切
    if (normalized.endsWith(target) || target.endsWith(normalized)) {
      const ratio =
        Math.min(normalized.length, target.length) / Math.max(normalized.length, target.length);
      if (ratio >= 0.6) best = Math.max(best, 800 + Math.round(ratio * 100));
    }
  }
  if (best > 0) return best;

  // 3) 词元重叠：按非字母数字切分，统计共同词的数量
  const tokensOf = (value: string) =>
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token !== "");
  const sourceTokens = tokensOf(modelTail(catalogId));
  const targetTokens = tokensOf(needle);
  if (sourceTokens.length === 0 || targetTokens.length === 0) return 0;
  let shared = 0;
  for (const token of targetTokens) {
    if (sourceTokens.includes(token)) shared += 1;
  }
  const overlap = shared / Math.max(sourceTokens.length, targetTokens.length);
  // 至少一半词元相同才认为是"最可能"的候选
  return overlap >= 0.5 ? 500 + Math.round(overlap * 100) : 0;
}

/** 候选集按「分数高者优先；同分取 catalogId 字典序」选定，保证确定性 */
function pickBest(
  candidates: Array<{ entry: ModelCatalogEntry; score: number }>,
): ModelCatalogEntry | null {
  let best: { entry: ModelCatalogEntry; score: number } | null = null;
  for (const candidate of candidates) {
    if (candidate.score <= 0) continue;
    if (
      best === null ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.entry.catalogId < best.entry.catalogId)
    ) {
      best = candidate;
    }
  }
  return best?.entry ?? null;
}

/**
 * 匹配算法（返回"最可能"的一条，不要求完全一致）：
 * 1. 精确（小写）匹配；
 * 2. 忽略 provider 前缀后一致；
 * 3. 模糊打分（归一化相等 > 尾部包含 > 词元重叠），取分数最高者；
 * 4. 均无足够相似 → null。
 */
export function matchCatalogEntry(
  index: ReadonlyMap<string, ModelCatalogEntry>,
  id: string,
): ModelCatalogEntry | null {
  const needle = id.trim().toLowerCase();
  if (needle === "") return null;

  // 1) 精确匹配（大小写不敏感）
  const exact = index.get(needle);
  if (exact) return exact;

  // 2) 忽略 provider 前缀后完全一致；多个候选按 catalogId 字典序取第一个
  const withoutProvider: ModelCatalogEntry[] = [];
  const fuzzy: Array<{ entry: ModelCatalogEntry; score: number }> = [];
  for (const entry of index.values()) {
    if (modelTail(entry.catalogId) === needle) {
      withoutProvider.push(entry);
      continue;
    }
    const score = fuzzyScore(entry.catalogId, needle);
    if (score > 0) fuzzy.push({ entry, score });
  }
  const sorted = [...withoutProvider].sort((a, b) =>
    a.catalogId < b.catalogId ? -1 : a.catalogId > b.catalogId ? 1 : 0,
  );
  return sorted[0] ?? pickBest(fuzzy);
}

/** 兼容数组与「provider/model 为 key 的对象」两种形态，逐条解析 */
function parseCatalogPayload(payload: unknown): ModelCatalogEntry[] {
  const items = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? Object.values(payload)
      : [];
  const entries: ModelCatalogEntry[] = [];
  for (const item of items) {
    const entry = toCatalogEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** 目录内存态：解析后的索引 + 过期时间戳（毫秒） */
interface CatalogState {
  index: Map<string, ModelCatalogEntry>;
  expiresAt: number;
}

let state: CatalogState | null = null;
/** 进行中的刷新，避免并发重复请求 */
let inflight: Promise<boolean> | null = null;
/** 连续失败时的下一次重试时间戳，避免频繁打网络 */
let retryAt = 0;
let lastError = "CATALOG_UNAVAILABLE";

function cacheFilePath(): string {
  return path.join(dataDir(), "cache", "models-dev.json");
}

/** 读取磁盘缓存；文件缺失/损坏/解析为空都视为无缓存 */
async function readCacheFile(): Promise<CatalogState | null> {
  const filePath = cacheFilePath();
  try {
    const fileStat = await stat(filePath);
    const text = await readFile(filePath, "utf8");
    const entries = parseCatalogPayload(JSON.parse(text) as unknown);
    if (entries.length === 0) return null;
    return { index: buildCatalogIndex(entries), expiresAt: fileStat.mtimeMs + CACHE_TTL_MS };
  } catch {
    return null;
  }
}

/**
 * 拉取全量目录并落盘；成功返回 true。
 * 失败时保留旧缓存（即使已过期），只用冷却时间推迟下一次刷新。
 */
async function refresh(): Promise<boolean> {
  if (inflight) return inflight;
  const run = (async () => {
    try {
      const response = await net.fetch(CATALOG_URL, {
        method: "GET",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP_${response.status}`);
      const payload: unknown = await response.json();
      const entries = parseCatalogPayload(payload);
      if (entries.length === 0) throw new Error("EMPTY_CATALOG");

      // 缓存落盘失败不影响本次结果，只是下次启动需要重新拉取
      try {
        const filePath = cacheFilePath();
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, JSON.stringify(payload), "utf8");
      } catch (error) {
        console.warn(
          `[models-catalog] 写入缓存失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }

      state = { index: buildCatalogIndex(entries), expiresAt: Date.now() + CACHE_TTL_MS };
      retryAt = 0;
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      retryAt = Date.now() + REFRESH_RETRY_MS;
      // 旧缓存顺延到冷却结束，期间继续可用；到期后再尝试后台刷新
      if (state) state = { ...state, expiresAt: retryAt };
      console.warn(`[models-catalog] 刷新 models.dev 目录失败：${lastError}`);
      return false;
    } finally {
      inflight = null;
    }
  })();
  inflight = run;
  return run;
}

/** 核心查询：优先内存 → 磁盘缓存 → 网络；过期时后台刷新且本次仍用旧数据 */
async function lookupModel(id: string): Promise<ModelLookupResult> {
  const trimmed = id.trim();
  if (trimmed === "") return { ok: true, match: null };

  if (!state) state = await readCacheFile();

  if (!state) {
    // 无任何缓存：必须等一次网络请求，失败则返回目录不可用
    if (Date.now() >= retryAt) await refresh();
  } else if (Date.now() >= state.expiresAt && Date.now() >= retryAt) {
    // 已过期：后台刷新，本次请求仍用旧数据
    void refresh();
  }

  const current = state;
  if (!current) return { ok: false, reason: lastError };
  return { ok: true, match: matchCatalogEntry(current.index, trimmed) };
}

export function registerModelsCatalogIpc(): void {
  ipcMain.handle(
    IPC.models.lookup,
    async (_event, request: { id: string }): Promise<ModelLookupResult> =>
      lookupModel(typeof request?.id === "string" ? request.id : ""),
  );
}
