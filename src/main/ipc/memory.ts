// IPC：长期记忆向量引擎
// 与知识库物理隔离，存储全局用户记忆与项目上下文记忆。
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { net } from "electron";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { ensureDir } from "../lib/fs-utils.js";
import { normalizeBaseUrl, errorMessage } from "../lib/http-utils.js";
import { dataDir } from "../lib/app-paths.js";
import { clampNumber, cosineSimilarity } from "../lib/utils.js";

const MEMORY_TYPES = new Set([
  "preference",
  "profile",
  "project",
  "instruction",
  "correction",
  "communication",
  "workflow",
  "tool",
  "goal",
  "constraint",
]);
const MEMORY_SCOPES = new Set(["global", "project"]);
const DEFAULT_DEDUPE_THRESHOLD = 0.92;

// 记忆记录结构
interface MemoryRecord {
  id: string;
  scope: string;
  type: string;
  content: string;
  sourceThreadId?: string;
  projectKey?: string;
  confidence: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number;
  useCount: number;
  archived: boolean;
  indexed?: boolean;
  score?: number;
  fallback?: boolean;
}

interface EmbeddingConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  dimension?: number | string;
}

// 查询向量缓存（LRU）
const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 500;

function getCachedEmbedding(model: string, text: string): number[] | null {
  const key = `${model}:${text}`;
  const cached = embeddingCache.get(key);
  if (cached) {
    // LRU：移到末尾
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }
  return null;
}

function setCachedEmbedding(model: string, text: string, vector: number[]) {
  const key = `${model}:${text}`;
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    // 删除最旧的（第一个）
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, vector);
}

// 按作用域的写入锁队列
const scopeLocks = new Map<string, Promise<unknown>>();

function withScopeLock<T>(scope: string, fn: () => Promise<T>): Promise<T> {
  const prev = scopeLocks.get(scope) || Promise.resolve();
  const next = prev.then(fn, fn);
  scopeLocks.set(scope, next.catch(() => {}));
  return next;
}

function baseMemoryDir(): string {
  return path.resolve(dataDir(), "memory");
}

function scopeDir(scope: string): string {
  const folder = scope === "project" ? "project-context" : "user-preferences";
  const base = baseMemoryDir();
  const dir = path.resolve(base, folder);
  if (!dir.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Invalid memory scope: ${scope}`);
  }
  return dir;
}

function memoriesPath(scope: string): string {
  return path.join(scopeDir(scope), "memories.jsonl");
}

function vectorsPath(scope: string): string {
  return path.join(scopeDir(scope), "vectors.jsonl");
}

function metadataPath(scope: string): string {
  return path.join(scopeDir(scope), "metadata.json");
}

async function ensureScope(scope: string): Promise<void> {
  await ensureDir(scopeDir(scope));
  if (!fs.existsSync(memoriesPath(scope))) {
    await fsp.writeFile(memoriesPath(scope), "", "utf8");
  }
  if (!fs.existsSync(vectorsPath(scope))) {
    await fsp.writeFile(vectorsPath(scope), "", "utf8");
  }
  if (!fs.existsSync(metadataPath(scope))) {
    await saveMetadata(scope, {
      scope,
      embeddingConfig: null,
      lastError: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
}

async function ensureAllScopes(): Promise<void> {
  await Promise.all(["global", "project"].map((scope) => ensureScope(scope)));
}

// JSONL 读缓存：本模块是这些文件的唯一写入方（全部经 writeJsonl），
// 写入时同步更新缓存即可保证一致。记录对象按不可变约定使用，调用方不得原地修改。
const jsonlCache = new Map<string, unknown[]>();

async function readJsonl<T>(file: string): Promise<T[]> {
  if (jsonlCache.has(file)) return jsonlCache.get(file) as T[];
  if (!fs.existsSync(file)) return [];
  const content = await fsp.readFile(file, "utf8");
  const records = content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
  jsonlCache.set(file, records);
  return records;
}

async function writeJsonl(file: string, records: unknown[]): Promise<void> {
  await ensureDir(path.dirname(file));
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  const content = lines ? `${lines}\n` : "";
  // 先写临时文件，再 rename，保证原子性
  const tmpFile = `${file}.tmp`;
  await fsp.writeFile(tmpFile, content, "utf8");
  await fsp.rename(tmpFile, file);
  jsonlCache.set(file, records);
}

async function loadMemories(scope: string): Promise<MemoryRecord[]> {
  await ensureScope(scope);
  return readJsonl<MemoryRecord>(memoriesPath(scope));
}

async function saveMemories(scope: string, memories: MemoryRecord[]): Promise<void> {
  await writeJsonl(memoriesPath(scope), memories);
  const meta = (await loadMetadata(scope)) ?? {};
  await saveMetadata(scope, { ...meta, scope, updatedAt: Date.now() });
}

async function loadVectors(scope: string): Promise<Array<{ id: string; vector: number[] }>> {
  await ensureScope(scope);
  return readJsonl<{ id: string; vector: number[] }>(vectorsPath(scope));
}

async function saveVectors(scope: string, vectors: Array<{ id: string; vector: number[] }>): Promise<void> {
  await writeJsonl(vectorsPath(scope), vectors);
}

async function loadMetadata(scope: string): Promise<Record<string, unknown> | null> {
  await ensureScope(scope);
  const file = metadataPath(scope);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function saveMetadata(scope: string, meta: unknown): Promise<void> {
  await ensureDir(scopeDir(scope));
  await fsp.writeFile(metadataPath(scope), JSON.stringify(meta, null, 2), "utf8");
}

function normalizeScope(scope: unknown): string {
  return scope === "project" ? "project" : "global";
}

function normalizeType(type: unknown, scope: string): string {
  if (typeof type === "string" && MEMORY_TYPES.has(type)) return type;
  return scope === "project" ? "project" : "preference";
}

function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );
}

function createMemoryId(): string {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMemoryInput(memory: Record<string, unknown>): MemoryRecord {
  const scope = normalizeScope(memory?.scope);
  const content = String(memory?.content ?? "").replace(/\s+/g, " ").trim();
  if (!content) throw new Error("记忆内容不能为空");
  const now = Date.now();
  return {
    id: typeof memory?.id === "string" && (memory.id as string).trim() ? (memory.id as string).trim() : createMemoryId(),
    scope,
    type: normalizeType(memory?.type, scope),
    content,
    sourceThreadId:
      typeof memory?.sourceThreadId === "string" ? memory.sourceThreadId : undefined,
    projectKey:
      scope === "project" && typeof memory?.projectKey === "string"
        ? memory.projectKey.trim()
        : undefined,
    confidence: clampNumber(memory?.confidence, 0, 1, 0.8),
    tags: normalizeTags(memory?.tags),
    createdAt: Number(memory?.createdAt) || now,
    updatedAt: Number(memory?.updatedAt) || now,
    lastUsedAt: Number(memory?.lastUsedAt) || undefined,
    useCount: Number(memory?.useCount) || 0,
    archived: Boolean(memory?.archived),
  };
}

async function embedTexts(texts: string[], config: EmbeddingConfig | null | undefined): Promise<number[][]> {
  const { apiKey, baseURL, model, dimension } = config || {};
  if (!apiKey || !baseURL || !model) throw new Error("嵌入配置不完整");
  const modelName = String(model).trim();

  // 先检查缓存
  const results: number[][] = new Array(texts.length);
  const missingIndexes: number[] = [];
  const missingTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = getCachedEmbedding(modelName, texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      missingIndexes.push(i);
      missingTexts.push(texts[i]);
    }
  }
  if (missingTexts.length === 0) {
    return results;
  }

  const body: Record<string, unknown> = { model: modelName, input: missingTexts };
  if (dimension != null && dimension !== "" && dimension !== 0) {
    const dimensions = Number(dimension);
    if (Number.isFinite(dimensions) && dimensions > 0) {
      body.dimensions = Math.trunc(dimensions);
    }
  }

  const MAX_RETRIES = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await net.fetch(`${normalizeBaseUrl(baseURL)}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${String(apiKey).trim()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const payload = await response.json();
      if (!response.ok) {
        const error = new Error(`嵌入 API 失败 (${response.status}): ${errorMessage(payload)}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }
      const data = payload as { data?: Array<{ embedding: number[] }> };
      const embeddings = (data.data || []).map((item) => item.embedding);
      // 验证每个向量
      for (const emb of embeddings) {
        if (!Array.isArray(emb) || emb.length === 0) {
          throw new Error("嵌入 API 返回了无效的空向量");
        }
      }
      if (embeddings.length !== missingTexts.length) {
        throw new Error(
          `嵌入 API 返回数量不匹配：请求 ${missingTexts.length} 条，返回 ${embeddings.length} 条`,
        );
      }
      for (let i = 0; i < missingTexts.length; i++) {
        const vector = embeddings[i];
        setCachedEmbedding(modelName, missingTexts[i], vector);
        results[missingIndexes[i]] = vector;
      }
      return results;
    } catch (error) {
      lastError = error;
      // 4xx（除 429 限流）是确定性失败，重试只会白等，直接抛出
      const status = (error as Error & { status?: number })?.status;
      const retryable = status == null || status === 429 || status >= 500;
      if (!retryable || attempt === MAX_RETRIES - 1) throw error;
      const delay = 500 * Math.pow(2, attempt);
      console.warn(`嵌入 API 第 ${attempt + 1} 次失败，${delay}ms 后重试: ${(error as Error).message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

function projectMatches(memory: MemoryRecord, projectKey: string): boolean {
  if (memory.scope !== "project") return true;
  if (!projectKey) return true;
  return memory.projectKey === projectKey;
}

function filterMemories(memories: MemoryRecord[], request: Record<string, unknown> = {}): MemoryRecord[] {
  const scopes = Array.isArray(request.scopes)
    ? new Set((request.scopes as unknown[]).map(normalizeScope))
    : null;
  const type = typeof request.type === "string" ? request.type : undefined;
  const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  return memories.filter((memory) => {
    if (!request.includeArchived && memory.archived) return false;
    if (scopes && !scopes.has(memory.scope)) return false;
    if (type && memory.type !== type) return false;
    if (request.projectKey && !projectMatches(memory, request.projectKey as string)) return false;
    if (query) {
      const haystack = `${memory.content} ${(memory.tags || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

async function listMemory(request: Record<string, unknown> = {}) {
  await ensureAllScopes();
  const [
    globalMemories,
    projectMemories,
    globalVectors,
    projectVectors,
  ] = await Promise.all([
    loadMemories("global"),
    loadMemories("project"),
    loadVectors("global"),
    loadVectors("project"),
  ]);
  const globalVectorIds = new Set(globalVectors.map((record) => record.id));
  const projectVectorIds = new Set(projectVectors.map((record) => record.id));
  const all = [
    ...globalMemories.map((memory) => ({
      ...memory,
      indexed: globalVectorIds.has(memory.id),
    })),
    ...projectMemories.map((memory) => ({
      ...memory,
      indexed: projectVectorIds.has(memory.id),
    })),
  ];
  return filterMemories(all, request).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function createMemory(request: Record<string, unknown>) {
  const memory = normalizeMemoryInput(request?.memory as Record<string, unknown> || {});
  if (memory.scope === "project" && !memory.projectKey) {
    throw new Error("项目记忆缺少 projectKey");
  }

  // 向量只依赖记忆内容，在锁外计算：避免嵌入网络调用（120s 超时 + 重试）
  // 把同作用域的全部写操作串行卡死
  const config = (request?.config as Record<string, unknown>)?.embedding
    ? ((request.config as Record<string, unknown>).embedding as EmbeddingConfig)
    : (request?.config as EmbeddingConfig);
  const [vector] = await embedTexts([memory.content], config);

  return withScopeLock(memory.scope, async () => {
    await verifyEmbeddingConfig(memory.scope, config, vector);

    const memories = await loadMemories(memory.scope);
    const vectors = await loadVectors(memory.scope);
    const dedupeThreshold = clampNumber(
      request?.dedupeThreshold,
      0.75,
      0.99,
      DEFAULT_DEDUPE_THRESHOLD,
    );

    let bestMatch: { memory: MemoryRecord; score: number } | null = null;
    for (const existing of memories) {
      if (existing.archived) continue;
      if (existing.type !== memory.type) continue;
      if (existing.scope !== memory.scope) continue;
      if (existing.scope === "project" && existing.projectKey !== memory.projectKey) continue;
      const existingVector = vectors.find((record) => record.id === existing.id)?.vector;
      const score = cosineSimilarity(vector, existingVector as number[]);
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { memory: existing, score };
      }
    }

    if (bestMatch && bestMatch.score >= dedupeThreshold) {
      const updated = {
        ...bestMatch.memory,
        content: memory.content,
        confidence: Math.max(bestMatch.memory.confidence ?? 0, memory.confidence ?? 0),
        sourceThreadId: memory.sourceThreadId ?? bestMatch.memory.sourceThreadId,
        tags: Array.from(new Set([...(bestMatch.memory.tags || []), ...memory.tags])),
        updatedAt: Date.now(),
        archived: false,
      };
      await saveMemories(
        memory.scope,
        memories.map((item) => (item.id === updated.id ? updated : item)),
      );
      await saveVectors(
        memory.scope,
        vectors.map((item) => (item.id === updated.id ? { id: updated.id, vector } : item)),
      );
      return { success: true, memory: updated, deduped: true, score: bestMatch.score };
    }

    await saveMemories(memory.scope, [...memories, memory]);
    await saveVectors(memory.scope, [...vectors, { id: memory.id, vector }]);

    return { success: true, memory, deduped: false };
  });
}

async function verifyEmbeddingConfig(scope: string, config: EmbeddingConfig | null, vector: number[]): Promise<void> {
  const meta = (await loadMetadata(scope)) ?? {};
  const actualDim = vector?.length;
  if (!actualDim) throw new Error("嵌入 API 未返回向量");
  const storedConfig = meta.embeddingConfig as { dimension?: number } | null | undefined;
  if (
    storedConfig &&
    storedConfig.dimension &&
    storedConfig.dimension !== actualDim
  ) {
    throw new Error(
      `向量维度不匹配：记忆索引使用 ${storedConfig.dimension} 维，当前模型生成 ${actualDim} 维。请重建记忆索引。`,
    );
  }
  await saveMetadata(scope, {
    ...meta,
    scope,
    embeddingConfig: {
      model: config?.model,
      dimension: actualDim,
    },
    lastError: null,
    updatedAt: Date.now(),
  });
}

function tokenize(text: string): string[] {
  const normalized = String(text || "").toLowerCase();
  const tokens = new Set<string>();

  // 英文、数字单词
  const wordRegex = /[a-z0-9]+/g;
  let match;
  while ((match = wordRegex.exec(normalized)) !== null) {
    tokens.add(match[0]);
  }

  // 中文字符与相邻 bigram
  const cjkRegex = /[\u4e00-\u9fff]/g;
  const cjkChars: string[] = [];
  while ((match = cjkRegex.exec(normalized)) !== null) {
    cjkChars.push(match[0]);
    tokens.add(match[0]);
  }
  for (let i = 0; i < cjkChars.length - 1; i++) {
    tokens.add(cjkChars[i] + cjkChars[i + 1]);
  }

  return Array.from(tokens);
}

function keywordSearch(memories: MemoryRecord[], queryTokens: string[]): Array<MemoryRecord & { score: number }> {
  if (!queryTokens || queryTokens.length === 0) return [];
  const results: Array<MemoryRecord & { score: number }> = [];
  for (const memory of memories) {
    const text = `${memory.content || ""} ${(memory.tags || []).join(" ")}`;
    const memoryTokens = new Set(tokenize(text));
    let matched = 0;
    for (const token of queryTokens) {
      if (memoryTokens.has(token)) matched++;
    }
    const score = matched / queryTokens.length;
    if (score > 0) {
      results.push({ ...memory, score });
    }
  }
  return results;
}

function mergeSearchResults(
  keywordResults: Array<MemoryRecord & { score: number }>,
  vectorResults: Array<MemoryRecord & { score: number }>,
  topK: number,
): Array<MemoryRecord & { score: number }> {
  const map = new Map<string, { memory: MemoryRecord & { score: number }; rrfScore: number; bestScore: number }>();
  const keywordRanked = [...keywordResults].sort((a, b) => b.score - a.score);
  const vectorRanked = [...vectorResults].sort((a, b) => b.score - a.score);

  // RRF 融合分数只用于排序；对外返回的 score 保持 0~1 相似度口径
  //（取关键词命中率与向量余弦相似度中的较高者），
  // 下游（矛盾检测阈值、工具展示的"相似度"）都按 0~1 语义消费该字段。
  const add = (item: MemoryRecord & { score: number }, rank: number) => {
    const entry = map.get(item.id);
    if (entry) {
      entry.rrfScore += 1 / (60 + rank + 1);
      entry.bestScore = Math.max(entry.bestScore, item.score);
      // 向量命中的记录带 indexed 标记，优先保留
      if (item.indexed) entry.memory = item;
    } else {
      map.set(item.id, {
        memory: item,
        rrfScore: 1 / (60 + rank + 1),
        bestScore: item.score,
      });
    }
  };
  keywordRanked.forEach((item, index) => add(item, index));
  vectorRanked.forEach((item, index) => add(item, index));

  return Array.from(map.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK)
    .map(({ memory, bestScore }) => ({ ...memory, score: bestScore }));
}

async function searchMemory(request: Record<string, unknown>) {
  const query = String(request?.query || "").trim();
  if (!query) throw new Error("检索关键词不能为空");
  const config = (request?.config as Record<string, unknown>)?.embedding
    ? ((request.config as Record<string, unknown>).embedding as EmbeddingConfig)
    : (request?.config as EmbeddingConfig);
  const scopes = Array.isArray(request?.scopes)
    ? (request.scopes as unknown[]).map(normalizeScope)
    : ["global", "project"];
  const topK = clampNumber(request?.topK, 1, 20, 5);
  const threshold = clampNumber(request?.threshold, 0, 0.99, 0.4);

  // 2. 尝试向量检索（失败时降级为空结果）
  let queryVector: number[] | null = null;
  try {
    [queryVector] = await embedTexts([query], config);
  } catch (err) {
    console.warn("向量检索失败，降级为关键词检索:", (err as Error).message);
  }

  // 3. 始终执行关键词检索
  const queryTokens = tokenize(query);
  const keywordResults: Array<MemoryRecord & { score: number }> = [];
  const vectorResults: Array<MemoryRecord & { score: number }> = [];
  const allFilteredMemories: MemoryRecord[] = [];

  for (const scope of scopes) {
    const memories = await loadMemories(scope);
    const filtered = filterMemories(memories, {
      scopes: [scope],
      projectKey: request?.projectKey,
      includeArchived: request?.includeArchived,
    });
    allFilteredMemories.push(...filtered);

    keywordResults.push(...keywordSearch(filtered, queryTokens));

    if (queryVector) {
      const meta = await loadMetadata(scope);
      const metaConfig = meta?.embeddingConfig as { dimension?: number } | null | undefined;
      if (
        metaConfig?.dimension &&
        metaConfig.dimension !== queryVector.length
      ) {
        console.warn(`${scope} 向量维度不匹配，跳过该作用域的向量检索`);
        continue;
      }
      const vectors = await loadVectors(scope);
      const vectorMap = new Map(vectors.map((record) => [record.id, record.vector]));
      for (const memory of filtered) {
        const vector = vectorMap.get(memory.id);
        if (!vector) continue; // 没有向量则跳过，避免传入空数组
        const score = cosineSimilarity(queryVector, vector);
        if (score >= threshold) {
          vectorResults.push({ ...memory, indexed: true, score });
        }
      }
    }
  }

  // 4. 融合两种检索结果
  let results = mergeSearchResults(keywordResults, vectorResults, topK);

  // 5. 降级策略：两者都为空且调用方显式允许时，返回最近更新的记忆。
  // 结果带 fallback 标记且 score 为 0，调用方（如 search_memory 工具）需按
  // "非直接匹配"呈现；forget_memory 等破坏性路径不允许降级，避免误删无关记忆。
  if (results.length === 0 && request?.allowFallback) {
    results = allFilteredMemories
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, topK)
      .map((memory) => ({ ...memory, score: 0, fallback: true }));
  }

  if (results.length > 0) {
    await touchMemories(results.map((memory) => memory.id));
  }
  return { success: true, results };
}

async function touchMemories(ids: string[]): Promise<void> {
  const idSet = new Set(ids);
  for (const scope of ["global", "project"]) {
    // 整表读改写必须与 create/update/archive/delete 共用作用域锁，
    // 否则锁外覆写会把并发写入的新记忆静默回滚
    await withScopeLock(scope, async () => {
      const memories = await loadMemories(scope);
      let changed = false;
      const updated = memories.map((memory) => {
        if (!idSet.has(memory.id)) return memory;
        changed = true;
        return {
          ...memory,
          lastUsedAt: Date.now(),
          useCount: Number(memory.useCount || 0) + 1,
        };
      });
      if (changed) await saveMemories(scope, updated);
    });
  }
}

async function findMemoryById(id: string): Promise<{ scope: string; memories: MemoryRecord[]; memory: MemoryRecord; index: number } | null> {
  for (const scope of ["global", "project"]) {
    const memories = await loadMemories(scope);
    const index = memories.findIndex((memory) => memory.id === id);
    if (index >= 0) {
      return { scope, memories, memory: memories[index], index };
    }
  }
  return null;
}

async function updateMemory(request: Record<string, unknown>) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);
  const updates = (request?.updates || {}) as Record<string, unknown>;

  // 内容变更时的新向量只依赖新内容本身，在锁外预先计算，避免网络调用占锁
  const embedConfig = request?.config
    ? (request.config as Record<string, unknown>).embedding
      ? ((request.config as Record<string, unknown>).embedding as EmbeddingConfig)
      : (request.config as EmbeddingConfig)
    : null;
  const normalizedContent =
    typeof updates.content === "string"
      ? updates.content.replace(/\s+/g, " ").trim()
      : null;
  let newVector: number[] | null = null;
  if (updates.content && normalizedContent && embedConfig) {
    [newVector] = await embedTexts([normalizedContent], embedConfig);
  }

  return withScopeLock(target.scope, async () => {
    const memories = await loadMemories(target.scope);
    const memory = memories.find((m) => m.id === id);
    if (!memory) throw new Error(`记忆不存在: ${id}`);

    const next = {
      ...memory,
      ...updates,
      id: memory.id,
      scope: memory.scope,
      type: normalizeType(updates.type ?? memory.type, memory.scope),
      tags: updates.tags ? normalizeTags(updates.tags) : memory.tags,
      content: normalizedContent != null ? normalizedContent : memory.content,
      confidence:
        updates.confidence == null
          ? memory.confidence
          : clampNumber(updates.confidence, 0, 1, memory.confidence),
      updatedAt: Date.now(),
    };
    if (!next.content) throw new Error("记忆内容不能为空");

    const updatedMemories = memories.map((m) => (m.id === id ? next : m));
    await saveMemories(target.scope, updatedMemories);

    if (newVector && embedConfig) {
      await verifyEmbeddingConfig(target.scope, embedConfig, newVector);
      const vectors = await loadVectors(target.scope);
      const hasVector = vectors.some((record) => record.id === id);
      await saveVectors(
        target.scope,
        hasVector
          ? vectors.map((record) => (record.id === id ? { id, vector: newVector } : record))
          : [...vectors, { id, vector: newVector }],
      );
    }

    return { success: true, memory: next };
  });
}

async function archiveMemory(request: Record<string, unknown>) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const archived = request?.archived !== false;
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);

  return withScopeLock(target.scope, async () => {
    const memories = await loadMemories(target.scope);
    const memory = memories.find((m) => m.id === id);
    if (!memory) throw new Error(`记忆不存在: ${id}`);
    const next = { ...memory, archived, updatedAt: Date.now() };
    await saveMemories(
      target.scope,
      memories.map((m) => (m.id === id ? next : m)),
    );
    return { success: true, memory: next };
  });
}

async function deleteMemory(request: Record<string, unknown>) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);

  return withScopeLock(target.scope, async () => {
    const memories = await loadMemories(target.scope);
    if (!memories.some((m) => m.id === id)) {
      throw new Error(`记忆不存在: ${id}`);
    }
    await saveMemories(
      target.scope,
      memories.filter((m) => m.id !== id),
    );
    const vectors = await loadVectors(target.scope);
    await saveVectors(target.scope, vectors.filter((record) => record.id !== id));
    return { success: true };
  });
}

async function memoryStats() {
  const all = await listMemory({ includeArchived: true });
  const active = all.filter((memory) => !memory.archived);
  const archived = all.filter((memory) => memory.archived);
  const byScope: Record<string, number> = { global: 0, project: 0 };
  const byType: Record<string, number> = {};
  for (const memory of active) {
    byScope[memory.scope] += 1;
    byType[memory.type] = (byType[memory.type] || 0) + 1;
  }
  const metadata = {
    global: await loadMetadata("global"),
    project: await loadMetadata("project"),
  };
  return {
    success: true,
    total: all.length,
    active: active.length,
    archived: archived.length,
    byScope,
    byType,
    metadata,
  };
}

async function rebuildMemory(request: Record<string, unknown>) {
  const config = (request?.config as Record<string, unknown>)?.embedding
    ? ((request.config as Record<string, unknown>).embedding as EmbeddingConfig)
    : (request?.config as EmbeddingConfig);
  const scopeFilter = request?.scope ? [normalizeScope(request.scope)] : ["global", "project"];
  let rebuilt = 0;
  for (const scope of scopeFilter) {
    const memories = await loadMemories(scope);
    const vectors: Array<{ id: string; vector: number[] }> = [];
    if (memories.length > 0) {
      const embeddings = await embedTexts(memories.map((memory) => memory.content), config);
      memories.forEach((memory, index) => {
        vectors.push({ id: memory.id, vector: embeddings[index] });
      });
      await verifyEmbeddingConfig(scope, config, embeddings[0]);
    }
    await saveVectors(scope, vectors);
    rebuilt += memories.length;
  }
  return { success: true, rebuilt };
}

function register(ipcMain: IpcMain) {
  ipcMain.handle("memory:list", (_event: IpcMainInvokeEvent, { request }: { request?: Record<string, unknown> } = {}) => listMemory(request));
  ipcMain.handle("memory:search", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => searchMemory(request));
  ipcMain.handle("memory:create", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => createMemory(request));
  ipcMain.handle("memory:update", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => updateMemory(request));
  ipcMain.handle("memory:delete", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => deleteMemory(request));
  ipcMain.handle("memory:archive", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => archiveMemory(request));
  ipcMain.handle("memory:stats", () => memoryStats());
  ipcMain.handle("memory:rebuild", (_event: IpcMainInvokeEvent, { request }: { request: Record<string, unknown> }) => rebuildMemory(request));
}

export {
  register,
};
