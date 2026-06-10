// IPC：知识库向量引擎（文档解析、分块、嵌入、余弦检索）
// 纯主进程内存向量库，零原生依赖，万级分块毫秒级检索。
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { net } = require("electron");

const { ensureDir, readText } = require("../lib/fs-utils.cjs");
const { normalizeBaseUrl, errorMessage } = require("../lib/http-utils.cjs");
const { dataDir } = require("../lib/app-paths.cjs");

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".json",
  ".csv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".sh",
  ".rb",
  ".php",
  ".sql",
  ".env",
]);

// ─────────────────────────────────────────────────────────────────────────
// 文档解析：支持纯文本/代码文件、.pdf、.docx
// ─────────────────────────────────────────────────────────────────────────

async function parseDocument(filePath) {
  const baseName = path.basename(filePath).toLowerCase();
  const ext = baseName === ".env" ? ".env" : path.extname(filePath).toLowerCase();
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`文件不存在: ${filePath}`);

  if (TEXT_EXTENSIONS.has(ext)) {
    return await readText(filePath);
  }

  switch (ext) {
    case ".pdf":
      return await parsePdf(filePath);
    case ".docx":
      return await parseDocx(filePath);
    default:
      throw new Error(`不支持的文件类型: ${ext}`);
  }
}

async function parsePdf(filePath) {
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(await fsp.readFile(filePath));
    const pdf = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
    const texts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => item.str || "").join(" ");
      if (pageText.trim()) texts.push(pageText.trim());
    }
    return texts.join("\n\n");
  } catch (error) {
    throw new Error(`PDF 解析失败: ${error.message}`);
  }
}

async function parseDocx(filePath) {
  try {
    const mammoth = await import("mammoth");
    const buffer = await fsp.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  } catch (error) {
    throw new Error(`DOCX 解析失败: ${error.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 文本分块：固定 token 窗口 + 重叠
// ─────────────────────────────────────────────────────────────────────────

function chunkText(text, chunkSize = 512, overlap = 50) {
  const tokens = simpleTokenize(text);
  const chunks = [];
  let i = 0;
  while (i < tokens.length) {
    const end = Math.min(i + chunkSize, tokens.length);
    chunks.push(tokens.slice(i, end).join(""));
    i += chunkSize - overlap;
    if (i >= tokens.length) break;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

function simpleTokenize(text) {
  const tokens = [];
  let buffer = "";
  for (const char of text) {
    buffer += char;
    if (/[\s\n\r,.!?;:，。！？；：、]/.test(char) && buffer.length > 0) {
      tokens.push(buffer);
      buffer = "";
    }
  }
  if (buffer) tokens.push(buffer);
  return tokens;
}

// ─────────────────────────────────────────────────────────────────────────
// 嵌入 API：调用 OpenAI 兼容接口
// ─────────────────────────────────────────────────────────────────────────

async function embedTexts(texts, config) {
  const { apiKey, baseURL, model, dimension } = config;
  if (!apiKey || !baseURL || !model) throw new Error("嵌入配置不完整");

  const body = { model: model.trim(), input: texts };

  // 仅当 dimension 存在且为有效正整数时才添加 dimensions 参数
  // dimension 为 0 时表示使用模型默认维度，不传参数
  if (dimension != null && dimension !== "" && dimension !== 0) {
    const dimensions = Number(dimension);
    if (Number.isFinite(dimensions) && dimensions > 0) {
      body.dimensions = Math.trunc(dimensions);
    }
  }

  const response = await net.fetch(`${normalizeBaseUrl(baseURL)}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok) {
    console.error("嵌入 API 请求失败:", {
      status: response.status,
      model: body.model,
      inputCount: texts.length,
      dimensions: body.dimensions,
      response: payload,
    });
    throw new Error(`嵌入 API 失败 (${response.status}): ${errorMessage(payload)}`);
  }

  return (payload.data || []).map((item) => item.embedding);
}

// ─────────────────────────────────────────────────────────────────────────
// 向量存储：JSONL 格式，每行一条记录
// ─────────────────────────────────────────────────────────────────────────

function knowledgeDir(kbId) {
  if (!kbId || typeof kbId !== "string") {
    throw new Error(`Invalid kbId: ${kbId}`);
  }
  if (!/^kb-[A-Za-z0-9_-]+$/.test(kbId)) {
    throw new Error(`Invalid kbId: ${kbId}`);
  }

  const baseDir = path.resolve(dataDir(), "knowledge");
  const dir = path.resolve(baseDir, kbId);
  if (!dir.startsWith(`${baseDir}${path.sep}`)) {
    throw new Error(`Invalid knowledge path: ${kbId}`);
  }
  return dir;
}

function vectorsPath(kbId) {
  return path.join(knowledgeDir(kbId), "vectors.jsonl");
}

function metadataPath(kbId) {
  return path.join(knowledgeDir(kbId), "metadata.json");
}

function filesListPath(kbId) {
  return path.join(knowledgeDir(kbId), "files.json");
}

async function saveVectors(kbId, records) {
  await ensureDir(knowledgeDir(kbId));
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  await fsp.writeFile(vectorsPath(kbId), lines, "utf8");
}

async function loadVectors(kbId) {
  const file = vectorsPath(kbId);
  if (!fs.existsSync(file)) return [];
  const content = await fsp.readFile(file, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function saveMetadata(kbId, meta) {
  await ensureDir(knowledgeDir(kbId));
  await fsp.writeFile(metadataPath(kbId), JSON.stringify(meta, null, 2), "utf8");
}

async function loadMetadata(kbId) {
  const file = metadataPath(kbId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

async function saveFilesList(kbId, files) {
  await ensureDir(knowledgeDir(kbId));
  await fsp.writeFile(filesListPath(kbId), JSON.stringify(files, null, 2), "utf8");
}

async function loadFilesList(kbId) {
  const file = filesListPath(kbId);
  if (!fs.existsSync(file)) return [];
  return JSON.parse(await fsp.readFile(file, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────
// 余弦相似度检索
// ─────────────────────────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    console.warn(`向量维度不匹配: ${a?.length} vs ${b?.length}`);
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function searchVectors(kbId, queryVector, topK = 5, threshold = 0.6) {
  const records = await loadVectors(kbId);
  console.log(`[searchVectors] kbId=${kbId}, records=${records.length}, queryVector dim=${queryVector.length}, threshold=${threshold}`);
  const scored = records
    .map((r) => ({
      ...r,
      score: cosineSimilarity(queryVector, r.vector),
    }))
    .sort((a, b) => b.score - a.score);

  // 调试：显示前 5 个最高分
  console.log(`[searchVectors] 前5个最高分:`, scored.slice(0, 5).map(r => r.score.toFixed(4)));

  let results = scored.filter((r) => r.score >= threshold).slice(0, topK);

  // 即使没有达到阈值，也至少返回 1 个最相似的结果
  if (results.length === 0 && scored.length > 0) {
    results = [scored[0]];
    console.log(`[searchVectors] 无结果达到阈值，返回最高分: ${scored[0].score.toFixed(4)}`);
  }

  console.log(`[searchVectors] 匹配结果数: ${results.length}, 阈值: ${threshold}`);
  return results.map(({ vector, ...rest }) => rest);
}

// ─────────────────────────────────────────────────────────────────────────
// IPC 接口
// ─────────────────────────────────────────────────────────────────────────

// 创建空知识库
async function createKnowledgeBase(request) {
  const { kbId, name, description, chunkSize = 512, overlap = 50 } = request;
  await ensureDir(knowledgeDir(kbId));

  const meta = {
    kbId,
    name,
    description,
    chunkSize,
    overlap,
    enabled: true,
    fileCount: 0,
    chunkCount: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // 记录嵌入配置（首次添加文件时写入）
    embeddingConfig: null,
  };

  await saveMetadata(kbId, meta);
  await saveVectors(kbId, []); // 创建空向量文件
  await saveFilesList(kbId, []); // 创建空文件列表

  return { success: true, knowledgeBase: { ...meta, id: meta.kbId } };
}

// 添加文件到知识库
async function addFilesToKnowledge(request) {
  const { kbId, filePaths, config } = request;
  const { chunkSize = 512, overlap = 50 } = config;

  const meta = await loadMetadata(kbId);
  if (!meta) throw new Error(`知识库不存在: ${kbId}`);

  const existingVectors = await loadVectors(kbId);
  const existingFiles = await loadFilesList(kbId);
  const newRecords = [];
  const processedFiles = [];

  for (const filePath of filePaths) {
    try {
      // 检查是否已存在
      if (existingFiles.some(f => f.path === filePath)) {
        console.warn(`文件已存在，跳过: ${filePath}`);
        continue;
      }

      const stat = await fsp.stat(filePath);
      const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const text = await parseDocument(filePath);
      const chunks = chunkText(text, chunkSize, overlap);

      for (let i = 0; i < chunks.length; i++) {
        newRecords.push({
          id: `${fileId}_${i}`,
          fileId,
          file: filePath,
          chunk: i,
          text: chunks[i],
          vector: null,
        });
      }

      processedFiles.push({
        id: fileId,
        kbId,
        name: path.basename(filePath),
        path: filePath,
        size: stat.size,
        type: path.extname(filePath).toLowerCase(),
        status: "ready",
        chunkCount: chunks.length,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error(`处理文件失败 ${filePath}:`, error);
      const fileId = `file-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      processedFiles.push({
        id: fileId,
        kbId,
        name: path.basename(filePath),
        path: filePath,
        size: 0,
        type: path.extname(filePath).toLowerCase(),
        status: "error",
        error: error.message,
        chunkCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  }

  // 生成嵌入向量
  if (newRecords.length > 0) {
    const texts = newRecords.map((r) => r.text);
    const vectors = await embedTexts(texts, config.embedding);

    // 首次添加文件时，记录嵌入配置
    if (!meta.embeddingConfig && vectors.length > 0) {
      meta.embeddingConfig = {
        model: config.embedding.model,
        dimension: vectors[0].length,
      };
    }

    // 验证向量维度一致性
    if (meta.embeddingConfig && vectors.length > 0) {
      const actualDim = vectors[0].length;
      if (actualDim !== meta.embeddingConfig.dimension) {
        throw new Error(
          `向量维度不匹配：知识库使用 ${meta.embeddingConfig.dimension} 维（${meta.embeddingConfig.model}），当前模型生成 ${actualDim} 维。请重建知识库或使用相同配置。`
        );
      }
    }

    newRecords.forEach((r, i) => (r.vector = vectors[i]));
  }

  // 合并并保存
  const allVectors = [...existingVectors, ...newRecords];
  const allFiles = [...existingFiles, ...processedFiles];

  await saveVectors(kbId, allVectors);
  await saveFilesList(kbId, allFiles);

  meta.fileCount = allFiles.filter(f => f.status === "ready").length;
  meta.chunkCount = allVectors.length;
  meta.updatedAt = Date.now();
  await saveMetadata(kbId, meta);

  return {
    success: true,
    addedFiles: processedFiles,
    totalFiles: meta.fileCount,
    totalChunks: meta.chunkCount,
  };
}

// 从知识库删除文件
async function removeFileFromKnowledge(request) {
  const { kbId, fileId } = request;

  const vectors = await loadVectors(kbId);
  const files = await loadFilesList(kbId);
  const meta = await loadMetadata(kbId);

  if (!meta) throw new Error(`知识库不存在: ${kbId}`);

  // 删除文件记录和相关向量
  const newFiles = files.filter(f => f.id !== fileId);
  const newVectors = vectors.filter(v => v.fileId !== fileId);

  await saveFilesList(kbId, newFiles);
  await saveVectors(kbId, newVectors);

  meta.fileCount = newFiles.filter(f => f.status === "ready").length;
  meta.chunkCount = newVectors.length;
  meta.updatedAt = Date.now();
  await saveMetadata(kbId, meta);

  return { success: true };
}

// 获取知识库文件列表
async function getKnowledgeFiles(kbId) {
  if (!kbId) {
    throw new Error("kbId is required");
  }
  const files = await loadFilesList(kbId);
  return files;
}

// 更新知识库配置
async function updateKnowledgeBase(request) {
  const { kbId, updates } = request;
  const meta = await loadMetadata(kbId);
  if (!meta) throw new Error(`知识库不存在: ${kbId}`);

  Object.assign(meta, updates, { updatedAt: Date.now() });
  await saveMetadata(kbId, meta);

  return { success: true, knowledgeBase: { ...meta, id: meta.kbId } };
}

// 重建知识库索引（重新嵌入所有文件）
async function rebuildKnowledge(request) {
  const { kbId, config } = request;
  const meta = await loadMetadata(kbId);
  const files = await loadFilesList(kbId);

  if (!meta) throw new Error(`知识库不存在: ${kbId}`);

  const { chunkSize, overlap } = meta;
  const newRecords = [];
  const updatedFiles = [];

  for (const file of files) {
    try {
      const text = await parseDocument(file.path);
      const chunks = chunkText(text, chunkSize, overlap);

      for (let i = 0; i < chunks.length; i++) {
        newRecords.push({
          id: `${file.id}_${i}`,
          fileId: file.id,
          file: file.path,
          chunk: i,
          text: chunks[i],
          vector: null,
        });
      }

      updatedFiles.push({
        ...file,
        status: "ready",
        error: undefined,
        chunkCount: chunks.length,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error(`重建文件失败 ${file.path}:`, error);
      updatedFiles.push({
        ...file,
        status: "error",
        error: error.message,
        updatedAt: Date.now(),
      });
    }
  }

  // 生成嵌入向量
  if (newRecords.length > 0) {
    const texts = newRecords.map((r) => r.text);
    const vectors = await embedTexts(texts, config.embedding);

    // 重建时更新嵌入配置
    if (vectors.length > 0) {
      meta.embeddingConfig = {
        model: config.embedding.model,
        dimension: vectors[0].length,
      };
    }

    newRecords.forEach((r, i) => (r.vector = vectors[i]));
  }

  await saveVectors(kbId, newRecords);
  await saveFilesList(kbId, updatedFiles);

  meta.fileCount = updatedFiles.filter(f => f.status === "ready").length;
  meta.chunkCount = newRecords.length;
  meta.updatedAt = Date.now();
  await saveMetadata(kbId, meta);

  return { success: true, fileCount: meta.fileCount, chunkCount: meta.chunkCount };
}

// 检查文件向量是否与当前嵌入配置兼容
async function checkFilesCompatibility(kbId, config) {
  const meta = await loadMetadata(kbId);
  const files = await loadFilesList(kbId);

  if (!meta?.embeddingConfig) return files;

  // 测试当前配置的向量维度
  const testVectors = await embedTexts(["test"], config.embedding);
  const currentDim = testVectors[0].length;

  // 标记不兼容的文件
  const updatedFiles = files.map((file) => {
    if (file.status === "ready" && currentDim !== meta.embeddingConfig.dimension) {
      return {
        ...file,
        status: "incompatible",
        error: `向量维度不匹配：文件使用 ${meta.embeddingConfig.dimension} 维，当前模型生成 ${currentDim} 维`,
      };
    }
    return file;
  });

  await saveFilesList(kbId, updatedFiles);
  return updatedFiles;
}

// 重新嵌入不兼容的文件
async function reembedIncompatibleFiles(request) {
  const { kbId, config } = request;
  const meta = await loadMetadata(kbId);
  const files = await loadFilesList(kbId);
  const vectors = await loadVectors(kbId);

  const incompatibleFiles = files.filter((f) => f.status === "incompatible");
  if (incompatibleFiles.length === 0) {
    return { success: true, reembedded: 0 };
  }

  const incompatibleFileIds = new Set(incompatibleFiles.map((f) => f.id));
  const newRecords = [];
  const updatedFiles = [];

  for (const file of incompatibleFiles) {
    try {
      const text = await parseDocument(file.path);
      const chunks = chunkText(text, meta.chunkSize, meta.overlap);

      for (let i = 0; i < chunks.length; i++) {
        newRecords.push({
          id: `${file.id}_${i}`,
          fileId: file.id,
          file: file.path,
          chunk: i,
          text: chunks[i],
          vector: null,
        });
      }

      updatedFiles.push({
        ...file,
        status: "ready",
        error: undefined,
        chunkCount: chunks.length,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error(`重新嵌入文件失败 ${file.path}:`, error);
      updatedFiles.push({
        ...file,
        status: "error",
        error: error.message,
        updatedAt: Date.now(),
      });
    }
  }

  if (newRecords.length > 0) {
    const texts = newRecords.map((r) => r.text);
    const newVectors = await embedTexts(texts, config.embedding);

    // 更新嵌入配置
    if (newVectors.length > 0) {
      meta.embeddingConfig = {
        model: config.embedding.model,
        dimension: newVectors[0].length,
      };
    }

    newRecords.forEach((r, i) => (r.vector = newVectors[i]));
  }

  // 删除旧向量，添加新向量
  const remainingVectors = vectors.filter((v) => !incompatibleFileIds.has(v.fileId));
  const allVectors = [...remainingVectors, ...newRecords];

  // 更新文件列表
  const finalFiles = files.map((f) => {
    const updated = updatedFiles.find((uf) => uf.id === f.id);
    return updated || f;
  });

  await saveVectors(kbId, allVectors);
  await saveFilesList(kbId, finalFiles);

  meta.fileCount = finalFiles.filter((f) => f.status === "ready").length;
  meta.chunkCount = allVectors.length;
  meta.updatedAt = Date.now();
  await saveMetadata(kbId, meta);

  return { success: true, reembedded: updatedFiles.length };
}

async function queryKnowledge(request) {
  const { kbId, query, config, topK = 5, threshold = 0.7 } = request;
  console.log(`[queryKnowledge] kbId=${kbId}, query="${query}", topK=${topK}, threshold=${threshold}`);
  const meta = await loadMetadata(kbId);

  // 验证嵌入配置一致性
  if (meta?.embeddingConfig) {
    const queryVectors = await embedTexts([query], config.embedding);
    const queryDim = queryVectors[0].length;
    console.log(`[queryKnowledge] 查询向量维度: ${queryDim}, 知识库维度: ${meta.embeddingConfig.dimension}`);
    if (queryDim !== meta.embeddingConfig.dimension) {
      throw new Error(
        `向量维度不匹配：知识库使用 ${meta.embeddingConfig.dimension} 维（${meta.embeddingConfig.model}），查询向量为 ${queryDim} 维。请使用相同的嵌入模型。`
      );
    }
    const results = await searchVectors(kbId, queryVectors[0], topK, threshold);
    return { success: true, results };
  }

  const [queryVector] = await embedTexts([query], config.embedding);
  console.log(`[queryKnowledge] 查询向量维度: ${queryVector.length}`);
  const results = await searchVectors(kbId, queryVector, topK, threshold);
  return { success: true, results };
}

async function scanFiles(dir, extensions) {
  const files = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await fsp.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (extensions.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

async function deleteKnowledge(kbId) {
  const dir = knowledgeDir(kbId);
  if (fs.existsSync(dir)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
  return { success: true };
}

async function listKnowledge() {
  const baseDir = path.join(dataDir(), "knowledge");
  if (!fs.existsSync(baseDir)) return [];
  const entries = await fsp.readdir(baseDir, { withFileTypes: true });
  const list = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith("kb-")) {
      const meta = await loadMetadata(entry.name);
      if (meta) {
        // 确保返回的对象有 id 字段
        list.push({ ...meta, id: meta.kbId || entry.name });
      }
    }
  }
  return list;
}

function register(ipcMain) {
  ipcMain.handle("knowledge:create", (_event, { request }) => createKnowledgeBase(request));
  ipcMain.handle("knowledge:update", (_event, { request }) => updateKnowledgeBase(request));
  ipcMain.handle("knowledge:addFiles", (_event, { request }) => addFilesToKnowledge(request));
  ipcMain.handle("knowledge:removeFile", (_event, { request }) => removeFileFromKnowledge(request));
  ipcMain.handle("knowledge:getFiles", (_event, params) => {
    console.log("knowledge:getFiles params:", params);
    return getKnowledgeFiles(params?.kbId);
  });
  ipcMain.handle("knowledge:rebuild", (_event, { request }) => rebuildKnowledge(request));
  ipcMain.handle("knowledge:query", (_event, { request }) => queryKnowledge(request));
  ipcMain.handle("knowledge:delete", (_event, params) => {
    console.log("knowledge:delete params:", params);
    return deleteKnowledge(params?.kbId);
  });
  ipcMain.handle("knowledge:list", () => listKnowledge());
  ipcMain.handle("knowledge:checkCompatibility", (_event, { kbId, config }) => checkFilesCompatibility(kbId, config));
  ipcMain.handle("knowledge:reembedIncompatible", (_event, { request }) => reembedIncompatibleFiles(request));
}

module.exports = { register };
