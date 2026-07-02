// IPC：长期记忆向量引擎
// 与知识库物理隔离，存储全局用户记忆与项目上下文记忆。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { net } = require("electron");

const { ensureDir } = require("../lib/fs-utils.cjs");
const { normalizeBaseUrl, errorMessage } = require("../lib/http-utils.cjs");
const { dataDir } = require("../lib/app-paths.cjs");
const { clampNumber, cosineSimilarity } = require("../lib/utils.cjs");

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

function baseMemoryDir() {
  return path.resolve(dataDir(), "memory");
}

function scopeDir(scope) {
  const folder = scope === "project" ? "project-context" : "user-preferences";
  const base = baseMemoryDir();
  const dir = path.resolve(base, folder);
  if (!dir.startsWith(`${base}${path.sep}`)) {
    throw new Error(`Invalid memory scope: ${scope}`);
  }
  return dir;
}

function memoriesPath(scope) {
  return path.join(scopeDir(scope), "memories.jsonl");
}

function vectorsPath(scope) {
  return path.join(scopeDir(scope), "vectors.jsonl");
}

function metadataPath(scope) {
  return path.join(scopeDir(scope), "metadata.json");
}

async function ensureScope(scope) {
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

async function ensureAllScopes() {
  await Promise.all(["global", "project"].map((scope) => ensureScope(scope)));
}

async function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const content = await fsp.readFile(file, "utf8");
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function writeJsonl(file, records) {
  await ensureDir(path.dirname(file));
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  await fsp.writeFile(file, lines ? `${lines}\n` : "", "utf8");
}

async function loadMemories(scope) {
  await ensureScope(scope);
  return readJsonl(memoriesPath(scope));
}

async function saveMemories(scope, memories) {
  await writeJsonl(memoriesPath(scope), memories);
  const meta = (await loadMetadata(scope)) ?? {};
  await saveMetadata(scope, { ...meta, scope, updatedAt: Date.now() });
}

async function loadVectors(scope) {
  await ensureScope(scope);
  return readJsonl(vectorsPath(scope));
}

async function saveVectors(scope, vectors) {
  await writeJsonl(vectorsPath(scope), vectors);
}

async function loadMetadata(scope) {
  await ensureScope(scope);
  const file = metadataPath(scope);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function saveMetadata(scope, meta) {
  await ensureDir(scopeDir(scope));
  await fsp.writeFile(metadataPath(scope), JSON.stringify(meta, null, 2), "utf8");
}

function normalizeScope(scope) {
  return scope === "project" ? "project" : "global";
}

function normalizeType(type, scope) {
  if (MEMORY_TYPES.has(type)) return type;
  return scope === "project" ? "project" : "preference";
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(
      tags
        .filter((tag) => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12),
    ),
  );
}

function createMemoryId() {
  return `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeMemoryInput(memory) {
  const scope = normalizeScope(memory?.scope);
  const content = String(memory?.content ?? "").replace(/\s+/g, " ").trim();
  if (!content) throw new Error("记忆内容不能为空");
  const now = Date.now();
  return {
    id: typeof memory?.id === "string" && memory.id.trim() ? memory.id.trim() : createMemoryId(),
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

function hasSensitiveContent(text) {
  const value = String(text || "");
  const patterns = [
    /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[\w./+=-]{8,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/,
    /\b[A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    /\b\d{6}(?:19|20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
    /\b(?:\d[ -]?){13,19}\b/,
    /验证码|verification code|one[- ]?time code|otp/i,
  ];
  return patterns.some((pattern) => pattern.test(value));
}

async function embedTexts(texts, config) {
  const { apiKey, baseURL, model, dimension } = config || {};
  if (!apiKey || !baseURL || !model) throw new Error("嵌入配置不完整");

  const body = { model: String(model).trim(), input: texts };
  if (dimension != null && dimension !== "" && dimension !== 0) {
    const dimensions = Number(dimension);
    if (Number.isFinite(dimensions) && dimensions > 0) {
      body.dimensions = Math.trunc(dimensions);
    }
  }

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
    throw new Error(`嵌入 API 失败 (${response.status}): ${errorMessage(payload)}`);
  }
  return (payload.data || []).map((item) => item.embedding);
}

function projectMatches(memory, projectKey) {
  if (memory.scope !== "project") return true;
  if (!projectKey) return true;
  return memory.projectKey === projectKey;
}

function filterMemories(memories, request = {}) {
  const scopes = Array.isArray(request.scopes)
    ? new Set(request.scopes.map(normalizeScope))
    : null;
  const type = typeof request.type === "string" ? request.type : undefined;
  const query = typeof request.query === "string" ? request.query.trim().toLowerCase() : "";
  return memories.filter((memory) => {
    if (!request.includeArchived && memory.archived) return false;
    if (scopes && !scopes.has(memory.scope)) return false;
    if (type && memory.type !== type) return false;
    if (request.projectKey && !projectMatches(memory, request.projectKey)) return false;
    if (query) {
      const haystack = `${memory.content} ${(memory.tags || []).join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

async function listMemory(request = {}) {
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

async function createMemory(request) {
  const memory = normalizeMemoryInput(request?.memory);
  if (memory.scope === "project" && !memory.projectKey) {
    throw new Error("项目记忆缺少 projectKey");
  }
  if (request?.sensitiveFilter !== false && hasSensitiveContent(memory.content)) {
    throw new Error("记忆内容包含敏感信息，已跳过");
  }

  const config = request?.config?.embedding ? request.config.embedding : request?.config;
  const [vector] = await embedTexts([memory.content], config);
  await verifyEmbeddingConfig(memory.scope, config, vector);

  const memories = await loadMemories(memory.scope);
  const vectors = await loadVectors(memory.scope);
  const dedupeThreshold = clampNumber(
    request?.dedupeThreshold,
    0.75,
    0.99,
    DEFAULT_DEDUPE_THRESHOLD,
  );

  let bestMatch = null;
  for (const existing of memories) {
    if (existing.archived) continue;
    if (existing.type !== memory.type) continue;
    if (existing.scope !== memory.scope) continue;
    if (existing.scope === "project" && existing.projectKey !== memory.projectKey) continue;
    const existingVector = vectors.find((record) => record.id === existing.id)?.vector;
    const score = cosineSimilarity(vector, existingVector);
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
}

async function verifyEmbeddingConfig(scope, config, vector) {
  const meta = (await loadMetadata(scope)) ?? {};
  const actualDim = vector?.length;
  if (!actualDim) throw new Error("嵌入 API 未返回向量");
  if (
    meta.embeddingConfig &&
    meta.embeddingConfig.dimension &&
    meta.embeddingConfig.dimension !== actualDim
  ) {
    throw new Error(
      `向量维度不匹配：记忆索引使用 ${meta.embeddingConfig.dimension} 维，当前模型生成 ${actualDim} 维。请重建记忆索引。`,
    );
  }
  await saveMetadata(scope, {
    ...meta,
    scope,
    embeddingConfig: {
      model: config.model,
      dimension: actualDim,
    },
    lastError: null,
    updatedAt: Date.now(),
  });
}

async function searchMemory(request) {
  const query = String(request?.query || "").trim();
  if (!query) throw new Error("检索关键词不能为空");
  const config = request?.config?.embedding ? request.config.embedding : request?.config;
  const [queryVector] = await embedTexts([query], config);
  const scopes = Array.isArray(request?.scopes)
    ? request.scopes.map(normalizeScope)
    : ["global", "project"];
  const topK = clampNumber(request?.topK, 1, 20, 5);
  const threshold = clampNumber(request?.threshold, 0, 0.99, 0.62);

  const allResults = [];
  for (const scope of scopes) {
    const meta = await loadMetadata(scope);
    if (
      meta?.embeddingConfig?.dimension &&
      meta.embeddingConfig.dimension !== queryVector.length
    ) {
      throw new Error(
        `向量维度不匹配：${scope} 记忆索引使用 ${meta.embeddingConfig.dimension} 维，当前查询向量为 ${queryVector.length} 维。请重建记忆索引。`,
      );
    }
    const [memories, vectors] = await Promise.all([
      loadMemories(scope),
      loadVectors(scope),
    ]);
    const vectorMap = new Map(vectors.map((record) => [record.id, record.vector]));
    for (const memory of filterMemories(memories, {
      scopes: [scope],
      projectKey: request?.projectKey,
      includeArchived: request?.includeArchived,
    })) {
      const score = cosineSimilarity(queryVector, vectorMap.get(memory.id));
      if (score >= threshold) {
        allResults.push({
          ...memory,
          indexed: vectorMap.has(memory.id),
          score,
        });
      }
    }
  }

  const results = allResults.sort((a, b) => b.score - a.score).slice(0, topK);
  if (results.length > 0) {
    await touchMemories(results.map((memory) => memory.id));
  }
  return { success: true, results };
}

async function touchMemories(ids) {
  const idSet = new Set(ids);
  for (const scope of ["global", "project"]) {
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
  }
}

async function findMemoryById(id) {
  for (const scope of ["global", "project"]) {
    const memories = await loadMemories(scope);
    const index = memories.findIndex((memory) => memory.id === id);
    if (index >= 0) {
      return { scope, memories, memory: memories[index], index };
    }
  }
  return null;
}

async function updateMemory(request) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);
  const updates = request?.updates || {};
  const next = {
    ...target.memory,
    ...updates,
    id: target.memory.id,
    scope: target.memory.scope,
    type: normalizeType(updates.type ?? target.memory.type, target.memory.scope),
    tags: updates.tags ? normalizeTags(updates.tags) : target.memory.tags,
    content:
      typeof updates.content === "string"
        ? updates.content.replace(/\s+/g, " ").trim()
        : target.memory.content,
    confidence:
      updates.confidence == null
        ? target.memory.confidence
        : clampNumber(updates.confidence, 0, 1, target.memory.confidence),
    updatedAt: Date.now(),
  };
  if (!next.content) throw new Error("记忆内容不能为空");
  if (request?.sensitiveFilter !== false && hasSensitiveContent(next.content)) {
    throw new Error("记忆内容包含敏感信息，已跳过");
  }

  const memories = target.memories.map((memory) => (memory.id === id ? next : memory));
  await saveMemories(target.scope, memories);

  if (updates.content && request?.config) {
    const config = request.config.embedding ? request.config.embedding : request.config;
    const [vector] = await embedTexts([next.content], config);
    await verifyEmbeddingConfig(target.scope, config, vector);
    const vectors = await loadVectors(target.scope);
    const hasVector = vectors.some((record) => record.id === id);
    await saveVectors(
      target.scope,
      hasVector
        ? vectors.map((record) => (record.id === id ? { id, vector } : record))
        : [...vectors, { id, vector }],
    );
  }

  return { success: true, memory: next };
}

async function archiveMemory(request) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const archived = request?.archived !== false;
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);
  const next = {
    ...target.memory,
    archived,
    updatedAt: Date.now(),
  };
  await saveMemories(
    target.scope,
    target.memories.map((memory) => (memory.id === id ? next : memory)),
  );
  return { success: true, memory: next };
}

async function deleteMemory(request) {
  const id = String(request?.id || "").trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  const target = await findMemoryById(id);
  if (!target) throw new Error(`记忆不存在: ${id}`);
  await saveMemories(
    target.scope,
    target.memories.filter((memory) => memory.id !== id),
  );
  await saveVectors(
    target.scope,
    (await loadVectors(target.scope)).filter((record) => record.id !== id),
  );
  return { success: true };
}

async function memoryStats() {
  const all = await listMemory({ includeArchived: true });
  const active = all.filter((memory) => !memory.archived);
  const archived = all.filter((memory) => memory.archived);
  const byScope = { global: 0, project: 0 };
  const byType = {};
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

async function rebuildMemory(request) {
  const config = request?.config?.embedding ? request.config.embedding : request?.config;
  const scopeFilter = request?.scope ? [normalizeScope(request.scope)] : ["global", "project"];
  let rebuilt = 0;
  for (const scope of scopeFilter) {
    const memories = await loadMemories(scope);
    const vectors = [];
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

function register(ipcMain) {
  ipcMain.handle("memory:list", (_event, { request } = {}) => listMemory(request));
  ipcMain.handle("memory:search", (_event, { request }) => searchMemory(request));
  ipcMain.handle("memory:create", (_event, { request }) => createMemory(request));
  ipcMain.handle("memory:update", (_event, { request }) => updateMemory(request));
  ipcMain.handle("memory:delete", (_event, { request }) => deleteMemory(request));
  ipcMain.handle("memory:archive", (_event, { request }) => archiveMemory(request));
  ipcMain.handle("memory:stats", () => memoryStats());
  ipcMain.handle("memory:rebuild", (_event, { request }) => rebuildMemory(request));
}

module.exports = {
  register,
  hasSensitiveContent,
  normalizeMemoryInput,
};
