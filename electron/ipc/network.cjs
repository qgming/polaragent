// IPC：网络相关（跨域代理、技能广场搜索、内置助手广场、网络搜索）
const { net } = require("electron");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { projectResourcePath } = require("../lib/app-paths.cjs");
const { readText } = require("../lib/fs-utils.cjs");
const { errorMessage, normalizeBaseUrl, normalizeWebUrl } = require("../lib/http-utils.cjs");

const IMAGE_REQUEST_TIMEOUT_MS = 1800000;
const CORS_MAX_TIMEOUT_MS = 1800000;
const DEFAULT_TIMEOUT_MS = 120000;
const MIN_TIMEOUT_MS = 3000;
// 响应体大小上限（字节）：防止下载超大响应撑爆主进程内存
const MAX_RESPONSE_BYTES = 100 * 1024 * 1024;

// 把外部传入的超时值钳制到 [MIN, max] 区间，并对 NaN/非法值兜底为默认值。
function clampTimeout(value, max = CORS_MAX_TIMEOUT_MS) {
  const num = Number(value);
  const base = Number.isFinite(num) && num > 0 ? num : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(base, MIN_TIMEOUT_MS), max);
}

// 错误信息中的 URL 脱敏：去掉 query，避免潜在密钥写入日志/错误链路
function redactUrl(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(url).split("?")[0];
  }
}

function electronRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({
      url: String(url),
      method: options.method || "GET",
      redirect: "follow",
    });
    const headers = options.headers || {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null) request.setHeader(key, String(value));
    }

    let settled = false;
    const timeoutMs = clampTimeout(options.timeoutMs, options.maxTimeoutMs || CORS_MAX_TIMEOUT_MS);
    const maxBytes = Number(options.maxResponseBytes) > 0
      ? Number(options.maxResponseBytes)
      : MAX_RESPONSE_BYTES;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new Error(`请求超时（${timeoutMs}ms）：${redactUrl(url)}`));
    }, timeoutMs);

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    request.on("response", (response) => {
      const chunks = [];
      let received = 0;
      response.on("data", (chunk) => {
        if (settled) return;
        const buf = Buffer.from(chunk);
        received += buf.length;
        if (received > maxBytes) {
          finish(() =>
            reject(new Error(`响应体超过大小上限（${maxBytes} 字节）：${redactUrl(url)}`)),
          );
          request.abort();
          return;
        }
        chunks.push(buf);
      });
      response.on("end", () => {
        finish(() =>
          resolve({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            headers: response.headers || {},
            body: Buffer.concat(chunks),
          }),
        );
      });
      response.on("error", (error) => finish(() => reject(error)));
    });
    request.on("error", (error) => finish(() => reject(error)));

    if (options.body !== undefined && options.body !== null) request.write(options.body);
    request.end();
  });
}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function responseHeadersArray(headers) {
  return Object.entries(headers || {})
    .filter(([key]) => !["content-length", "transfer-encoding"].includes(key.toLowerCase()))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]);
}

function responseText(response) {
  return response.body.toString("utf8");
}

function responseJson(response, label) {
  const text = responseText(response);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 300)}`);
  }
}

// 跨域代理请求（过滤危险/受控请求头）
async function corsFetch(request) {
  const url = normalizeWebUrl(request.url);
  const method = String(request.method || "GET").toUpperCase();
  if (!["GET", "POST", "DELETE", "PUT", "PATCH", "OPTIONS"].includes(method)) {
    throw new Error(`跨域代理不支持的 HTTP 方法：${method}`);
  }
  const headers = {};
  for (const [key, value] of Object.entries(request.headers || {})) {
    const lower = key.toLowerCase();
    if (!["host", "connection", "content-length", "transfer-encoding", "origin", "referer"].includes(lower)) {
      headers[key] = value;
    }
  }
  const response = await electronRequest(url, {
    method,
    headers,
    body: request.body,
    timeoutMs: Math.min(Math.max(Number(request.timeoutMs || 120000), 3000), CORS_MAX_TIMEOUT_MS),
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeadersArray(response.headers),
    body: response.body.toString("utf8"),
  };
}

function imageMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function appendOptionalPart(parts, key, value) {
  if (value === undefined || value === null || value === "") return;
  parts.push({ name: key, value: String(value) });
}

function parseImageResponse(response) {
  const body = response.body.toString("utf8");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`图片接口返回了非 JSON 内容（HTTP ${response.status}）：${body.slice(0, 300)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`图片接口请求失败（${response.status}）：${errorMessage(payload)}`);
  }
  return payload;
}

function imageExtensionFromContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (value.includes("image/jpeg")) return "jpg";
  if (value.includes("image/webp")) return "webp";
  if (value.includes("image/gif")) return "gif";
  return "png";
}

async function downloadUrlAsBase64(request) {
  const url = normalizeWebUrl(request.url);
  const response = await electronRequest(url, {
    method: "GET",
    timeoutMs: Number(request.timeoutMs || IMAGE_REQUEST_TIMEOUT_MS),
  });
  if (response.status < 200 || response.status >= 300) {
    const body = response.body.toString("utf8");
    throw new Error(`下载文件失败（${response.status}）：${body.slice(0, 300) || response.statusText}`);
  }
  const contentType = headerValue(response.headers, "content-type");
  return {
    base64: response.body.toString("base64"),
    contentType,
    extension: imageExtensionFromContentType(contentType),
  };
}

function multipartEscape(value) {
  return String(value).replace(/"/g, "%22").replace(/\r?\n/g, " ");
}

function buildMultipartBody(parts) {
  const boundary = `----PolarAgentForm${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.buffer) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${multipartEscape(part.name)}"; filename="${multipartEscape(part.filename)}"\r\n` +
        `Content-Type: ${part.contentType || "application/octet-stream"}\r\n\r\n`,
      ));
      chunks.push(part.buffer);
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${multipartEscape(part.name)}"\r\n\r\n${String(part.value)}\r\n`,
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function openaiImageEdit(request) {
  const apiKey = String(request.apiKey || "").trim();
  const model = String(request.model || "").trim();
  const prompt = String(request.prompt || "").trim();
  const imagePath = String(request.imagePath || "").trim();
  if (!apiKey) throw new Error("图片生成 API Key 未配置。");
  if (!model) throw new Error("图片编辑模型未配置。");
  if (!prompt) throw new Error("图片编辑提示词不能为空。");
  if (!imagePath) throw new Error("图片编辑源文件不能为空。");

  async function buildMultipart() {
    const parts = [
      { name: "model", value: model },
      { name: "prompt", value: prompt },
    ];
    appendOptionalPart(parts, "n", request.n);
    appendOptionalPart(parts, "size", request.size);
    appendOptionalPart(parts, "quality", request.quality);
    appendOptionalPart(parts, "response_format", request.responseFormat);
    const imageBuffer = await fsp.readFile(imagePath);
    parts.push({
      name: "image",
      filename: path.basename(imagePath),
      contentType: imageMimeType(imagePath),
      buffer: imageBuffer,
    });

    if (request.maskPath) {
      const maskPath = String(request.maskPath).trim();
      const maskBuffer = await fsp.readFile(maskPath);
      parts.push({
        name: "mask",
        filename: path.basename(maskPath),
        contentType: imageMimeType(maskPath),
        buffer: maskBuffer,
      });
    }
    return buildMultipartBody(parts);
  }

  const multipart = await buildMultipart();
  const response = await electronRequest(`${normalizeBaseUrl(request.baseURL)}/images/edits`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
    timeoutMs: IMAGE_REQUEST_TIMEOUT_MS,
  });
  return parseImageResponse(response);
}

// 技能广场搜索（skillsmp.com）
async function skillsMarketSearch(request) {
  const query = String(request.query || "").trim();
  if (!query) throw new Error("缺少搜索关键词。");
  const page = Math.max(Number(request.page || 1), 1);
  const limit = Math.min(Math.max(Number(request.limit || 30), 1), 100);
  const sortBy = request.sortBy || "stars";
  const url = new URL("https://skillsmp.com/api/v1/skills/search");
  url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sortBy", sortBy);
  if (request.category) url.searchParams.set("category", request.category);
  if (request.occupation) url.searchParams.set("occupation", request.occupation);
  const headers = {};
  if (String(request.apiKey || "").trim()) headers.Authorization = `Bearer ${request.apiKey.trim()}`;
  const response = await electronRequest(url, { headers, timeoutMs: 30000 });
  const body = responseText(response);
  if (response.status < 200 || response.status >= 300) throw new Error(`技能广场请求失败（${response.status}）：${body}`);
  return body;
}

// 读取助手广场分类索引（不含 prompt，体积极小）
async function fetchAgentIndex() {
  const source = projectResourcePath("resources", "market", "agents", "index.json");
  if (!source) throw new Error("未找到助手广场索引：resources/market/agents/index.json");
  return readText(source);
}

// 按分类文件名读取该分类下的全部助手
// fileName 形如 "cat-编程.json"，来自索引，这里仍做白名单校验防止路径穿越
async function fetchAgentCategory(fileName) {
  if (typeof fileName !== "string" || !/^cat-[^\\/]+\.json$/.test(fileName)) {
    throw new Error(`非法的助手分类文件名：${fileName}`);
  }
  const source = projectResourcePath("resources", "market", "agents", fileName);
  if (!source) throw new Error(`未找到助手分类文件：resources/market/agents/${fileName}`);
  return readText(source);
}

// 网络搜索统一路由 - 根据 provider 选择不同的服务商
async function webSearch(request) {
  const provider = String(request.provider || "tavily");
  const query = String(request.query || "").trim();
  if (!query) throw new Error("缺少搜索关键词。");

  switch (provider) {
    case "tavily":
      return tavilySearch(request);
    case "exa":
      return exaSearch(request);
    case "serper":
      return serperSearch(request);
    case "searxng":
      return searxngSearch(request);
    case "brave":
      return braveSearch(request);
    default:
      throw new Error(`不支持的搜索服务商：${provider}`);
  }
}

// Tavily 搜索
async function tavilySearch(request) {
  const apiKey = String(request.apiKey || "").trim();
  if (!apiKey) throw new Error("Tavily API Key 未配置。");

  const url = "https://api.tavily.com/search";
  const body = {
    api_key: apiKey,
    query: request.query,
    search_depth: request.searchDepth || "basic",
    max_results: Math.min(Math.max(Number(request.limit || 5), 1), 10),
  };

  if (request.includeDomains) body.include_domains = request.includeDomains.split(",").map((d) => d.trim()).filter(Boolean);
  if (request.excludeDomains) body.exclude_domains = request.excludeDomains.split(",").map((d) => d.trim()).filter(Boolean);

  // 完整内容选项
  if (request.includeAnswer) body.include_answer = true;
  if (request.includeRawContent) body.include_raw_content = true;
  if (request.includeImages) body.include_images = true;

  const response = await electronRequest(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  const data = responseJson(response, "Tavily 搜索");
  if (response.status < 200 || response.status >= 300) throw new Error(`Tavily 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

  const results = (data.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.content || "",
    score: item.score,
    // 完整内容字段
    rawContent: item.raw_content,
    images: item.images,
  }));

  return {
    success: true,
    provider: "tavily",
    results,
    // AI 生成的答案（如果启用）
    answer: data.answer,
  };
}

// Exa 搜索
async function exaSearch(request) {
  const apiKey = String(request.apiKey || "").trim();
  if (!apiKey) throw new Error("Exa API Key 未配置。");

  const url = "https://api.exa.ai/search";
  const body = {
    query: request.query,
    num_results: Math.min(Math.max(Number(request.limit || 5), 1), 10),
    type: request.type || "neural",
  };

  if (request.useAutoprompt) body.use_autoprompt = true;
  if (request.category) body.category = request.category;

  // 完整内容选项
  if (request.includeText || request.includeHighlights || request.includeSummary) {
    body.contents = {
      text: request.includeText || false,
      highlights: request.includeHighlights || false,
      summary: request.includeSummary || false,
    };
  }

  const response = await electronRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  const data = responseJson(response, "Exa 搜索");
  if (response.status < 200 || response.status >= 300) throw new Error(`Exa 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

  const results = (data.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.snippet || item.text || "",
    score: item.score,
    // 完整内容字段
    text: item.text,
    highlights: item.highlights,
    summary: item.summary,
  }));

  return { success: true, provider: "exa", results };
}

// Serper 搜索（Google Search API）
async function serperSearch(request) {
  const apiKey = String(request.apiKey || "").trim();
  if (!apiKey) throw new Error("Serper API Key 未配置。");

  const url = "https://google.serper.dev/search";
  const body = {
    q: request.query,
    num: Math.min(Math.max(Number(request.limit || 5), 1), 10),
  };

  if (request.gl) body.gl = request.gl;
  if (request.hl) body.hl = request.hl;

  const response = await electronRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
    timeoutMs: 30000,
  });

  const data = responseJson(response, "Serper 搜索");
  if (response.status < 200 || response.status >= 300) throw new Error(`Serper 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

  const results = (data.organic || []).map((item) => ({
    title: item.title || "",
    url: item.link || "",
    snippet: item.snippet || "",
  }));

  return { success: true, provider: "serper", results };
}

// SearXNG 搜索（开源元搜索引擎）
async function searxngSearch(request) {
  const instances = (request.instances || "")
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean);

  // 如果用户未配置实例，使用默认公共实例
  const defaultInstances = [
    "https://noogle.maniworld31.com",
    "https://searxng.lmdr.io",
    "https://search.volmute.com",
    "https://google.thejot.org",
    "https://search.negrete.me",
    "https://ddg.thejot.org",
    "https://seachx.lunarfire.home64.de",
    "https://search.0x7c0.com",
    "https://rohsearch.com",
    "https://searxng.asudox.dev",
    "https://search.thejot.org",
    "https://sousuo.emoe.top",
    "https://searxng.tobe2d.dscloud.me",
    "https://searx.voe.chainsawgaming.de",
    "https://so.houhoukang.com",
    "https://searxng-pilot.jitera.app",
    "https://search.stryder.cc",
    "https://search.corrently.cloud",
    "https://searx.thejot.org",
    "https://searxng.josephzulick.com",
    "https://search.mixel.cloud",
    "https://searxng.ctrl.corpgroup.site",
    "https://search.skyday.eu",
    "https://search.privatevoid.net",
    "https://search.muellers-software.org",
    "https://search.jbtec.eu",
    "https://search.no-code.gdn",
    "https://www.correns.co",
    "https://search.die-blahuts.de",
    "https://searxng.vyro.ai",
    "https://searxng.sbbz-ilvesheim.de",
    "https://search.jakespeed.org",
    "https://searxng.pietro.in",
    "https://search.chgr.cc",
    "https://negativenull.com",
    "https://seek.nuer.cc",
    "https://search.lucathomas.de",
    "https://search.hirad.it",
    "https://search.notashelf.dev",
  ];

  const targetInstances = instances.length > 0 ? instances : defaultInstances;
  const limit = Math.min(Math.max(Number(request.limit || 5), 1), 10);

  // 尝试每个实例，直到成功
  let lastError = null;
  for (const instance of targetInstances) {
    try {
      const url = new URL("/search", instance);
      url.searchParams.set("q", request.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("pageno", "1");

      const response = await electronRequest(url, {
        method: "GET",
        timeoutMs: 15000,
      });

      if (response.status < 200 || response.status >= 300) continue;

      const data = responseJson(response, "SearXNG 搜索");
      const results = (data.results || [])
        .slice(0, limit)
        .map((item) => ({
          title: item.title || "",
          url: item.url || "",
          snippet: item.content || "",
        }));

      return { success: true, provider: "searxng", instance, results };
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  throw new Error(`所有 SearXNG 实例均不可用${lastError ? `：${lastError.message}` : ""}`);
}

// Brave 搜索
async function braveSearch(request) {
  const apiKey = String(request.apiKey || "").trim();
  if (!apiKey) throw new Error("Brave Search API Key 未配置。");

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", request.query);
  url.searchParams.set("count", String(Math.min(Math.max(Number(request.limit || 5), 1), 20)));

  if (request.country) url.searchParams.set("country", request.country);
  if (request.searchLang) url.searchParams.set("search_lang", request.searchLang);

  const response = await electronRequest(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
    timeoutMs: 30000,
  });

  const data = responseJson(response, "Brave 搜索");
  if (response.status < 200 || response.status >= 300) throw new Error(`Brave 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

  const results = (data.web?.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
  }));

  return { success: true, provider: "brave", results };
}

// 音频转写（语音识别 ASR）—— OpenAI /audio/transcriptions 接口
// 读取本地音频文件，multipart 上传，返回 JSON { text: "..." }
async function openaiTranscription(request) {
  const apiKey = String(request.apiKey || "").trim();
  const model = String(request.model || "").trim();
  const audioPath = String(request.audioPath || "").trim();
  if (!apiKey) throw new Error("语音识别 API Key 未配置。");
  if (!model) throw new Error("语音识别模型未配置。");
  if (!audioPath) throw new Error("音频文件路径不能为空。");

  const parts = [
    { name: "model", value: model },
  ];
  if (request.language) {
    appendOptionalPart(parts, "language", request.language);
  }
  appendOptionalPart(parts, "response_format", request.responseFormat || "json");

  const audioBuffer = await fsp.readFile(audioPath);
  parts.push({
    name: "file",
    filename: path.basename(audioPath),
    contentType: audioMimeType(audioPath),
    buffer: audioBuffer,
  });

  const multipart = buildMultipartBody(parts);
  const response = await electronRequest(`${normalizeBaseUrl(request.baseURL)}/audio/transcriptions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": multipart.contentType,
    },
    body: multipart.body,
    timeoutMs: 120000,
  });

  const body = response.body.toString("utf8");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`语音识别接口返回了非 JSON 内容（HTTP ${response.status}）：${body.slice(0, 300)}`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`语音识别失败（${response.status}）：${errorMessage(payload)}`);
  }
  return payload;
}

// 音频 MIME 类型判断（基于文件扩展名）
function audioMimeType(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".webm") return "audio/webm";
  if (ext === ".ogg") return "audio/ogg";
  return "audio/mpeg"; // 默认
}

// 语音合成（TTS）—— OpenAI /audio/speech 接口
// POST JSON，返回二进制音频流，转为 base64 返回给渲染进程
async function openaiSpeech(request) {
  const apiKey = String(request.apiKey || "").trim();
  const model = String(request.model || "").trim();
  const input = String(request.input || "").trim();
  const voice = String(request.voice || "alloy").trim();
  if (!apiKey) throw new Error("语音合成 API Key 未配置。");
  if (!model) throw new Error("语音合成模型未配置。");
  if (!input) throw new Error("合成文本不能为空。");

  const requestBody = {
    model,
    input,
    voice,
  };
  if (request.speed !== undefined && request.speed !== null) {
    requestBody.speed = Number(request.speed);
  }
  if (request.responseFormat) {
    requestBody.response_format = request.responseFormat;
  }

  const response = await electronRequest(`${normalizeBaseUrl(request.baseURL)}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    timeoutMs: 120000,
  });

  if (response.status < 200 || response.status >= 300) {
    const body = response.body.toString("utf8");
    throw new Error(`语音合成失败（${response.status}）：${body.slice(0, 300) || response.statusText}`);
  }

  // 从响应头推断音频格式
  const contentType = headerValue(response.headers, "content-type");
  const ext = audioExtensionFromContentType(contentType, request.responseFormat);

  return {
    base64: response.body.toString("base64"),
    contentType,
    extension: ext,
  };
}

// MiMo TTS —— /chat/completions 接口
// MiMo 使用 chat completions 格式，audio 在 response.choices[0].message.audio.data
async function mimoSpeech(request) {
  const apiKey = String(request.apiKey || "").trim();
  const model = String(request.model || "").trim();
  const input = String(request.input || "").trim();
  const voice = String(request.voice || "冰糖").trim();
  if (!apiKey) throw new Error("语音合成 API Key 未配置。");
  if (!model) throw new Error("语音合成模型未配置。");
  if (!input) throw new Error("合成文本不能为空。");

  // MiMo 格式：messages + audio 参数
  const requestBody = {
    model,
    messages: [
      { role: "user", content: request.stylePrompt || "" }, // 风格控制（可选）
      { role: "assistant", content: input },
    ],
    audio: {
      format: request.responseFormat || "mp3",
      voice,
    },
  };

  // MiMo 不支持 speed 参数（通过自然语言控制）

  const response = await electronRequest(`${normalizeBaseUrl(request.baseURL)}/chat/completions`, {
    method: "POST",
    headers: {
      "api-key": apiKey, // MiMo 使用 api-key 而非 Authorization
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    timeoutMs: 120000,
  });

  const body = response.body.toString("utf8");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`MiMo 语音合成接口返回了非 JSON 内容（HTTP ${response.status}）：${body.slice(0, 300)}`);
  }

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`MiMo 语音合成失败（${response.status}）：${errorMessage(payload)}`);
  }

  // 提取 audio.data
  const audioData = payload?.choices?.[0]?.message?.audio?.data;
  if (!audioData) {
    throw new Error("MiMo 语音合成响应中未找到 audio.data 字段。");
  }

  const format = request.responseFormat || "mp3";
  const ext = format === "pcm16" ? "pcm" : format;

  return {
    base64: audioData,
    contentType: `audio/${ext}`,
    extension: ext,
  };
}

// 从 Content-Type 或 responseFormat 推断音频扩展名
function audioExtensionFromContentType(contentType, responseFormat) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("audio/mpeg") || ct.includes("audio/mp3")) return "mp3";
  if (ct.includes("audio/wav")) return "wav";
  if (ct.includes("audio/opus")) return "opus";
  if (ct.includes("audio/aac")) return "aac";
  if (ct.includes("audio/flac")) return "flac";
  if (ct.includes("audio/webm")) return "webm";
  // 回退到 responseFormat
  const fmt = String(responseFormat || "").toLowerCase();
  if (fmt === "mp3" || fmt === "wav" || fmt === "opus" || fmt === "aac" || fmt === "flac") return fmt;
  return "mp3"; // 默认
}

function register(ipcMain) {
  ipcMain.handle("network:cors-fetch", (_event, { request }) => corsFetch(request));
  ipcMain.handle("network:skills-market-search", (_event, { request }) => skillsMarketSearch(request));
  ipcMain.handle("network:fetch-agent-index", fetchAgentIndex);
  ipcMain.handle("network:fetch-agent-category", (_event, { fileName }) => fetchAgentCategory(fileName));
  ipcMain.handle("network:web-search", (_event, { request }) => webSearch(request));
  ipcMain.handle("network:download-url-as-base64", (_event, { request }) => downloadUrlAsBase64(request));
  ipcMain.handle("network:openai-image-edit", (_event, { request }) => openaiImageEdit(request));
  ipcMain.handle("network:openai-transcription", (_event, { request }) => openaiTranscription(request));
  ipcMain.handle("network:openai-speech", (_event, { request }) => openaiSpeech(request));
  ipcMain.handle("network:mimo-speech", (_event, { request }) => mimoSpeech(request));
}

module.exports = { register };
