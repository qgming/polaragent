const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:1420";
const APP_ID = "com.qgming.polaragent";
const APP_NAME = "PolarAgent";

const MCP_PROTOCOL_VERSION = "2025-11-25";
const DEFAULT_SEARCH_INSTANCES = [
  "https://searx.be",
  "https://search.inetol.net",
  "https://searxng.site",
  "https://opnxng.com",
  "https://priv.au",
  "https://search.rhscz.eu",
  "https://baresearch.org",
  "https://search.hbubli.cc",
];
const MARKDOWN_READ_PROXIES = [
  "https://r.jina.ai/",
  "https://markdown.new/",
  "https://defuddle.md/",
];

let mainWindow;
const previewWindows = new Map();
const searchState = {
  signature: "",
  instances: [],
  nextIndex: 0,
};

function createMainWindow() {
  mainWindow = createWindow({
    width: 1240,
    height: 820,
    minWidth: 860,
    minHeight: 560,
    title: APP_NAME,
  });
  loadApp(mainWindow);
}

function createWindow(options) {
  const icon = appIconPath();
  const win = new BrowserWindow({
    ...options,
    ...(icon ? { icon } : {}),
    titleBarStyle: "hidden",
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  win.once("ready-to-show", () => win.show());
  const notifyMaximized = () => win.webContents.send("window:maximized-change", win.isMaximized());
  win.on("maximize", notifyMaximized);
  win.on("unmaximize", notifyMaximized);
  win.on("resize", notifyMaximized);
  return win;
}

function loadApp(win, query = "") {
  if (isDev) {
    win.loadURL(`${DEV_URL}${query}`);
  } else {
    win.loadFile(path.join(app.getAppPath(), "dist", "index.html"), query ? { query: parseQuery(query) } : undefined);
  }
}

function parseQuery(query) {
  const params = new URLSearchParams(query.replace(/^\?/, ""));
  return Object.fromEntries(params.entries());
}

function dataDir() {
  return app.getPath("userData");
}

function projectResourcePath(...segments) {
  const candidates = [
    path.join(process.resourcesPath || "", ...segments),
    path.join(app.getAppPath(), ...segments),
    path.join(process.cwd(), ...segments),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function appIconPath() {
  return (
    projectResourcePath("build", "icon.ico") ||
    projectResourcePath("build", "icon.png") ||
    projectResourcePath("dist", "logo.png") ||
    projectResourcePath("public", "logo.png")
  );
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readText(file) {
  return fsp.readFile(file, "utf8");
}

async function writeJsonFile(file, content) {
  JSON.parse(content);
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, file);
}

async function copyDirContents(source, target, overwriteExisting = true) {
  await ensureDir(target);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirContents(sourcePath, targetPath, overwriteExisting);
      continue;
    }
    if (!overwriteExisting && fs.existsSync(targetPath)) continue;
    await ensureDir(path.dirname(targetPath));
    await fsp.copyFile(sourcePath, targetPath);
  }
}

async function syncBuiltinResources() {
  const root = projectResourcePath("resources");
  if (!root) return;
  const dir = dataDir();
  await copyDirContents(path.join(root, "builtin", "skills"), path.join(dir, "skills", "builtin"), true).catch(() => {});
  await copyDirContents(path.join(root, "builtin", "agents"), path.join(dir, "agents", "builtin"), false).catch(() => {});
  await copyDirContents(path.join(root, "builtin", "mcp"), path.join(dir, "mcp", "builtin"), true).catch(() => {});
}

async function ensureDataDir() {
  const subdirs = [
    "config",
    "agents/builtin",
    "agents/custom",
    "skills/builtin",
    "skills/custom",
    "mcp/builtin",
    "mcp/packages/npm-cache",
    "conversations",
    "teams",
    "teams/conversations",
    "memory/project-context",
    "memory/user-preferences",
    "logs",
  ];
  await ensureDir(dataDir());
  await Promise.all(subdirs.map((subdir) => ensureDir(path.join(dataDir(), subdir))));
  await migrateAgentRootFiles();
  await syncBuiltinResources();
}

async function migrateAgentRootFiles() {
  const agentsDir = path.join(dataDir(), "agents");
  if (!fs.existsSync(agentsDir)) return;
  const entries = await fsp.readdir(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name) !== ".json") continue;
    const source = path.join(agentsDir, entry.name);
    const content = await readText(source).catch(() => "");
    const parsed = JSON.parse(content || "{}");
    const stem = path.basename(entry.name, ".json");
    const isBuiltin = parsed.type === "builtin" || ["default", "analyst", "research-expert"].includes(stem);
    const target = path.join(agentsDir, isBuiltin ? "builtin" : "custom", entry.name);
    await ensureDir(path.dirname(target));
    if (!fs.existsSync(target)) await fsp.rename(source, target);
    else await fsp.rm(source, { force: true });
  }
}

function configPath(fileName) {
  return path.join(dataDir(), "config", fileName);
}

function typedConfigDir(kind) {
  if (kind === "agents") return path.join(dataDir(), "agents");
  if (kind === "mcp") return path.join(dataDir(), "mcp");
  if (kind === "teams") return path.join(dataDir(), "teams");
  throw new Error(`Unknown config kind: ${kind}`);
}

async function listJsonIds(dir, subdirs) {
  if (!fs.existsSync(dir)) return [];
  const ids = new Set();
  const dirs = subdirs ? subdirs.map((subdir) => path.join(dir, subdir)) : [dir];
  for (const targetDir of dirs) {
    if (!fs.existsSync(targetDir)) continue;
    const entries = await fsp.readdir(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && path.extname(entry.name) === ".json") {
        ids.add(path.basename(entry.name, ".json"));
      }
    }
  }
  return Array.from(ids).sort();
}

async function readTypedConfig(kind, id) {
  const base = typedConfigDir(kind);
  const candidates =
    kind === "agents"
      ? [path.join(base, "custom", `${id}.json`), path.join(base, "builtin", `${id}.json`)]
      : [path.join(base, `${id}.json`)];
  const file = candidates.find((candidate) => fs.existsSync(candidate));
  if (!file) throw new Error(`${kind} config not found: ${id}`);
  return readText(file);
}

async function writeTypedConfig(kind, id, content) {
  const parsed = JSON.parse(content);
  const base = typedConfigDir(kind);
  const file =
    kind === "agents"
      ? path.join(base, parsed.type === "builtin" ? "builtin" : "custom", `${id}.json`)
      : path.join(base, `${id}.json`);
  await writeJsonFile(file, content);
}

async function deleteTypedConfig(kind, id) {
  const base = typedConfigDir(kind);
  const candidates =
    kind === "agents"
      ? [path.join(base, "custom", `${id}.json`), path.join(base, "builtin", `${id}.json`)]
      : [path.join(base, `${id}.json`)];
  await Promise.all(candidates.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL 不能为空");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function buildMessages(systemPrompt, messages) {
  const result = [];
  if (String(systemPrompt || "").trim()) {
    result.push({ role: "system", content: systemPrompt });
  }
  for (const message of messages || []) {
    if (String(message.content || "").trim()) {
      result.push({ role: message.role, content: message.content });
    }
  }
  return result;
}

function llmBody(request, stream) {
  const body = {
    model: String(request.model || "").trim(),
    messages: buildMessages(request.systemPrompt, request.messages),
    stream,
    temperature: request.temperature ?? 0.7,
    max_tokens: request.maxTokens ?? 4096,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (request.responseFormat === "json_object") body.response_format = { type: "json_object" };
  return body;
}

function usageFrom(raw) {
  const input = Number(raw?.prompt_tokens || 0);
  const output = Number(raw?.completion_tokens || 0);
  const totalTokens = Number(raw?.total_tokens || input + output);
  return { input, output, totalTokens };
}

function errorMessage(payload) {
  return payload?.error?.message || payload?.message || "服务返回错误";
}

async function chatCompletion(request) {
  if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
  if (!String(request.model || "").trim()) throw new Error("模型名称不能为空");
  const response = await fetch(`${normalizeBaseUrl(request.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(llmBody(request, false)),
    signal: AbortSignal.timeout(120000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`模型请求失败（${response.status}）：${errorMessage(payload)}`);
  return {
    content: payload.choices?.[0]?.message?.content || "",
    model: payload.model || request.model,
    usage: usageFrom(payload.usage),
  };
}

async function chatCompletionStream(event, request) {
  if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
  if (!String(request.model || "").trim()) throw new Error("模型名称不能为空");
  const requestId = request.requestId || `llm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await fetch(`${normalizeBaseUrl(request.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(llmBody({ ...request, requestId }, true)),
    signal: AbortSignal.timeout(300000),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(`模型请求失败（${response.status}）：${errorMessage(payload)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let model = request.model;
  let usage = { input: 0, output: 0, totalTokens: 0 };

  const emit = (payload) => event.sender.send("llm:chat-stream", payload);
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of block.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const payload = JSON.parse(data);
        if (payload.model) model = payload.model;
        if (payload.usage) usage = usageFrom(payload.usage);
        const delta = payload.choices?.[0]?.delta?.content;
        if (delta) emit({ requestId, delta, done: false });
      }
    }
  }
  emit({ requestId, done: true, model, usage });
}

async function listModels(request) {
  if (!String(request.apiKey || "").trim()) throw new Error("API Key 不能为空");
  const response = await fetch(`${normalizeBaseUrl(request.baseUrl)}/models`, {
    headers: { Authorization: `Bearer ${request.apiKey.trim()}` },
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`读取模型列表失败（${response.status}）：${errorMessage(payload)}`);
  return (payload.data || []).map((item) => item.id).filter(Boolean);
}

function encodeQueryComponent(input) {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function stripTags(input) {
  return decodeEntities(String(input).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

function decodeEntities(input) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function parseHtmlResults(html, limit) {
  const results = [];
  const blocks = String(html).split(/<article/i).slice(1);
  for (const raw of blocks) {
    if (results.length >= limit) break;
    const block = `<article${raw.split(/<\/article>/i)[0]}`;
    if (!/class=["'][^"']*result/i.test(block)) continue;
    const href = block.match(/href=["'](https?:\/\/[^"']+)["']/i)?.[1] || "";
    const title = stripTags(block.match(/<h3[\s\S]*?<\/h3>/i)?.[0] || "");
    const snippet = stripTags(block.match(/<p[^>]*class=["'][^"']*content[^"']*["'][\s\S]*?<\/p>/i)?.[0] || "");
    if (href) results.push({ title, url: href, snippet });
  }
  return results;
}

function ensureSearchInstances(instances) {
  const urls = (instances && instances.length ? instances : DEFAULT_SEARCH_INSTANCES)
    .map((url) => String(url).trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const signature = urls.join("|");
  if (signature !== searchState.signature) {
    searchState.signature = signature;
    searchState.instances = urls.map((baseUrl) => ({ baseUrl, cooldownUntil: 0 }));
    searchState.nextIndex = 0;
  }
}

function searchCandidates() {
  const now = Date.now();
  const result = [];
  const len = searchState.instances.length;
  for (let i = 0; i < len; i += 1) {
    const index = (searchState.nextIndex + i) % len;
    if (searchState.instances[index].cooldownUntil <= now) result.push(index);
  }
  if (result.length === 0 && len > 0) result.push(0);
  return result;
}

async function webSearch(request) {
  const query = String(request.query || "").trim();
  if (!query) {
    return { success: false, query: request.query || "", instance: "", totalCount: 0, results: [], error: "查询内容不能为空" };
  }
  ensureSearchInstances(request.instances || []);
  const limit = Math.min(Math.max(Number(request.limit || 5), 1), 10);
  const language = request.language || "zh-CN";
  const errors = [];
  for (const index of searchCandidates()) {
    const instance = searchState.instances[index];
    try {
      const url = `${instance.baseUrl}/search?q=${encodeQueryComponent(query)}&language=${encodeQueryComponent(language)}&safesearch=1`;
      const response = await fetch(url, {
        headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const html = await response.text();
      const results = parseHtmlResults(html, limit);
      instance.cooldownUntil = 0;
      searchState.nextIndex = (index + 1) % searchState.instances.length;
      return { success: true, query, instance: instance.baseUrl, totalCount: results.length, results };
    } catch (error) {
      instance.cooldownUntil = Date.now() + 180000;
      errors.push(`${instance.baseUrl}（${error.message}）`);
    }
  }
  return { success: false, query, instance: "", totalCount: 0, results: [], error: errors.slice(0, 3).join("；") || "没有可用的搜索实例" };
}

function normalizeWebUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("url 不能为空");
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 http/https URL");
  return url;
}

function looksBlocked(content) {
  return /captcha|not a bot|cloudflare|access denied|verify you are human|人机验证|安全验证/i.test(content);
}

function looksHtml(content) {
  return /<html|<body|<!doctype html/i.test(content.slice(0, 2000));
}

function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : undefined;
}

function extractReadable(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<\/(p|div|li|h1|h2|h3)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]*>/g, "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n"),
  );
}

function clipRead(markdown, maxChars, url, title, actualMethod) {
  const totalChars = Array.from(markdown).length;
  return {
    success: true,
    url,
    title,
    actualMethod,
    truncated: totalChars > maxChars,
    totalChars,
    markdown: Array.from(markdown).slice(0, maxChars).join(""),
  };
}

async function readViaProxy(clientUrl) {
  const errors = [];
  for (const proxy of MARKDOWN_READ_PROXIES) {
    const candidates = [`${proxy}${clientUrl}`];
    if (/[?#]/.test(clientUrl)) candidates.push(`${proxy}${encodeQueryComponent(clientUrl)}`);
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, {
          headers: { Accept: "text/markdown,text/plain;q=0.9,text/html;q=0.8", "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(12000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.text()).trim();
        if (!body || looksBlocked(body) || looksHtml(body)) throw new Error("返回内容不可用");
        return body;
      } catch (error) {
        errors.push(`${proxy}（${error.message}）`);
      }
    }
  }
  throw new Error(errors.slice(0, 2).join("，"));
}

async function readViaDirect(url, timeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5", "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (!html.trim() || looksBlocked(html)) throw new Error("返回内容为空或受限");
  const markdown = extractReadable(html);
  if (!markdown.trim() || looksBlocked(markdown)) throw new Error("正文提取失败");
  return { markdown, title: extractTitle(html) };
}

async function webRead(request) {
  let targetUrl;
  try {
    targetUrl = normalizeWebUrl(request.url);
  } catch (error) {
    return { success: false, url: request.url || "", truncated: false, totalChars: 0, markdown: "", error: error.message };
  }
  const maxChars = Math.min(Math.max(Number(request.maxChars || 12000), 1000), 30000);
  const timeoutMs = Math.min(Math.max(Number(request.timeoutMs || 12000), 3000), 30000);
  const method = request.method === "direct_html" ? "direct_html" : "proxy_markdown";
  if (method === "direct_html") {
    try {
      const { markdown, title } = await readViaDirect(targetUrl, timeoutMs);
      return clipRead(markdown, maxChars, targetUrl, title, "direct_html");
    } catch (error) {
      return { success: false, url: targetUrl, truncated: false, totalChars: 0, markdown: "", error: `直连读取失败：${error.message}` };
    }
  }
  try {
    const markdown = await readViaProxy(targetUrl);
    return clipRead(markdown, maxChars, targetUrl, undefined, "proxy_markdown");
  } catch (proxyError) {
    try {
      const { markdown, title } = await readViaDirect(targetUrl, timeoutMs);
      return clipRead(markdown, maxChars, targetUrl, title, "direct_html");
    } catch (directError) {
      return { success: false, url: targetUrl, truncated: false, totalChars: 0, markdown: "", error: `代理与直连均失败。代理：${proxyError.message}；直连：${directError.message}` };
    }
  }
}

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
  const response = await fetch(url, {
    method,
    headers,
    body: request.body,
    signal: AbortSignal.timeout(Math.min(Math.max(Number(request.timeoutMs || 120000), 3000), 300000)),
  });
  return {
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()).filter(([key]) => !["content-length", "transfer-encoding"].includes(key)),
    body: await response.text(),
  };
}

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
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`技能广场请求失败（${response.status}）：${body}`);
  return body;
}

async function fetchTextPrompts() {
  const source = projectResourcePath("resources", "market", "agents", "agents-zh.json");
  if (!source) throw new Error("未找到内置助手广场 JSON：resources/market/agents/agents-zh.json");
  return readText(source);
}

async function listSkills(skillType) {
  const dir = path.join(dataDir(), "skills", skillType === "builtin" ? "builtin" : "custom");
  return listJsonIds(dir).catch(async () => {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  });
}

async function readSkillMetadata(skillId) {
  for (const type of ["custom", "builtin"]) {
    const file = path.join(dataDir(), "skills", type, skillId, "SKILL.md");
    if (fs.existsSync(file)) return readText(file);
  }
  throw new Error(`Skill not found: ${skillId}`);
}

function supportedGitUrl(input) {
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@)/.test(input);
}

function sanitizeSlug(input) {
  return String(input).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function uniqueChild(parent, slug) {
  let candidate = path.join(parent, slug);
  let suffix = 1;
  while (fs.existsSync(candidate)) candidate = path.join(parent, `${slug}-${suffix++}`);
  return candidate;
}

function parseGithubSource(input) {
  const cleaned = input.trim().replace(/[?#].*$/, "").replace(/\/$/, "");
  const match = cleaned.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/(tree|blob)\/([^/]+)(?:\/(.+))?)?$/);
  if (!match) return null;
  return {
    cloneUrl: `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}.git`,
    branch: match[4],
    subdir: match[5],
  };
}

function gitSource(input) {
  const github = parseGithubSource(input);
  if (github) return github;
  return { cloneUrl: input, branch: undefined, subdir: undefined };
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function collectSkillRoots(root, depth = 0, matches = []) {
  if (depth > 4 || !fs.existsSync(root)) return matches;
  if (fs.existsSync(path.join(root, "SKILL.md"))) {
    matches.push(root);
    return matches;
  }
  const skillsDir = path.join(root, "skills");
  const scanRoot = depth === 0 && fs.existsSync(skillsDir) ? skillsDir : root;
  const entries = await fsp.readdir(scanRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || [".git", "node_modules"].includes(entry.name)) continue;
    await collectSkillRoots(path.join(scanRoot, entry.name), depth + 1, matches);
  }
  return matches;
}

async function installableSkillRoot(root) {
  const matches = await collectSkillRoots(root);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error("未找到 SKILL.md，无法安装为 Skill");
  throw new Error("该目录包含多个 SKILL.md，请安装单个 Skill 目录");
}

async function copySkill(source, target) {
  await ensureDir(target);
  const entries = await fsp.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) await copySkill(sourcePath, targetPath);
    else {
      await ensureDir(path.dirname(targetPath));
      await fsp.copyFile(sourcePath, targetPath);
    }
  }
}

async function installSkillFromGit(repoUrl) {
  const trimmed = String(repoUrl || "").trim();
  if (!trimmed) throw new Error("缺少 Git 仓库 URL");
  if (!supportedGitUrl(trimmed)) throw new Error("仅支持 http(s)、ssh 或 git 协议的 Git 仓库 URL");
  const customDir = path.join(dataDir(), "skills", "custom");
  const tmpRoot = path.join(dataDir(), "skills", ".tmp-install");
  await ensureDir(customDir);
  await ensureDir(tmpRoot);
  const source = gitSource(trimmed);
  const baseSlug = sanitizeSlug(source.subdir ? path.basename(source.subdir) : path.basename(source.cloneUrl, ".git"));
  const tempDir = uniqueChild(tmpRoot, baseSlug);
  const cloneDir = path.join(tempDir, "repo");
  await ensureDir(tempDir);
  try {
    const args = ["clone", "--depth", "1"];
    if (source.branch) args.push("--branch", source.branch);
    args.push("--", source.cloneUrl, cloneDir);
    await runProcess("git", args);
    const searchRoot = source.subdir ? path.join(cloneDir, source.subdir) : cloneDir;
    const skillRoot = await installableSkillRoot(searchRoot);
    const target = uniqueChild(customDir, sanitizeSlug(path.basename(skillRoot) || baseSlug));
    await copySkill(skillRoot, target);
    return target;
  } finally {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function installSkillFromLocal(sourcePath) {
  const source = String(sourcePath || "").trim();
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error("本地 Skill 源目录不存在");
  const skillRoot = await installableSkillRoot(source);
  const customDir = path.join(dataDir(), "skills", "custom");
  await ensureDir(customDir);
  const target = uniqueChild(customDir, sanitizeSlug(path.basename(skillRoot) || "skill"));
  await copySkill(skillRoot, target);
  return target;
}

function normalizeCommand(command, args) {
  const rawCommand = String(command || "").trim();
  if (!rawCommand) throw new Error("stdio MCP server 缺少 command");

  const name = path.basename(rawCommand).toLowerCase();
  const executable = process.platform === "win32" && name === "npx" ? "npx.cmd" : process.platform === "win32" && name === "npm" ? "npm.cmd" : rawCommand;
  const normalizedArgs = (args || [])
    .map((arg) => String(arg).trim())
    .filter(Boolean);
  if (name === "npx" && !normalizedArgs.some((arg) => arg === "-y" || arg === "--yes" || arg.startsWith("--yes="))) {
    normalizedArgs.unshift("-y");
  }
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(executable);
  return { executable, args: normalizedArgs, shell };
}

class StdioMcpClient {
  constructor(server) {
    const { executable, args, shell } = normalizeCommand(server.command, server.args || []);
    const packageDir = path.join(dataDir(), "mcp", "packages");
    const npmCacheDir = path.join(packageDir, "npm-cache");
    fs.mkdirSync(npmCacheDir, { recursive: true });
    this.child = spawn(executable, args, {
      cwd: packageDir,
      env: {
        ...process.env,
        npm_config_cache: npmCacheDir,
        NPM_CONFIG_CACHE: npmCacheDir,
        npm_config_yes: "true",
        NPM_CONFIG_YES: "true",
        ...(server.env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell,
      windowsHide: true,
    });
    this.nextId = 1;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      if (this.stderr.length < 8000) this.stderr += chunk;
    });
    this.child.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error(`MCP server 已退出${this.stderrHint()}`));
      this.pending.clear();
    });
  }

  stderrHint() {
    const trimmed = this.stderr.trim();
    return trimmed ? `，stderr：${trimmed}` : "";
  }

  onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const id = message.id;
      if (id != null && this.pending.has(id)) {
        const { resolve, reject, timer } = this.pending.get(id);
        clearTimeout(timer);
        this.pending.delete(id);
        if (message.error) reject(new Error(`MCP server 返回错误：${JSON.stringify(message.error)}`));
        else resolve(message.result || {});
      } else if (id != null && message.method) {
        this.write({ jsonrpc: "2.0", id, error: { code: -32601, message: "PolarAgent does not handle client-side MCP requests yet" } });
      }
    }
  }

  write(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params) {
    const id = this.nextId++;
    this.write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server 响应超时${this.stderrHint()}`));
      }, 60000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notification(method, params) {
    this.write(params == null ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: APP_NAME, version: app.getVersion() },
    });
    this.notification("notifications/initialized");
  }

  close() {
    this.child.kill();
  }
}

async function withStdioClient(server, run) {
  const client = new StdioMcpClient(server);
  try {
    await client.initialize();
    return await run(client);
  } finally {
    client.close();
  }
}

function registerHandlers() {
  ipcMain.handle("app:get-data-dir", () => dataDir());
  ipcMain.handle("app:ensure-data-dir", ensureDataDir);
  ipcMain.handle("app:open-data-dir", async () => {
    await ensureDir(dataDir());
    await shell.openPath(dataDir());
  });
  ipcMain.handle("app:open-path", async (_event, { path: target }) => shell.openPath(target));
  ipcMain.handle("app:open-external", async (_event, { url }) => shell.openExternal(url));
  ipcMain.handle("app:file-url", (_event, { path: target }) => pathToFileURL(target).toString());
  ipcMain.handle("dialog:pick-directory", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("dialog:pick-text-file", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters: [{ name: "文本文件", extensions: ["txt", "md", "markdown", "json", "csv", "log", "xml", "yaml", "yml", "toml", "ini", "html", "css", "ts", "tsx", "js", "jsx", "py", "rs", "go", "java", "c", "cpp", "h", "sh"] }],
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("window:minimize", (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle("window:close", (event) => BrowserWindow.fromWebContents(event.sender)?.close());
  ipcMain.handle("window:set-title", (event, { title }) => BrowserWindow.fromWebContents(event.sender)?.setTitle(String(title || APP_NAME)));
  ipcMain.handle("window:is-maximized", (event) => BrowserWindow.fromWebContents(event.sender)?.isMaximized() || false);
  ipcMain.handle("preview:open", async (_event, { path: filePath }) => {
    if (!filePath) return;
    const key = labelForPath(filePath);
    const existing = previewWindows.get(key);
    if (existing && !existing.isDestroyed()) {
      existing.show();
      existing.focus();
      return;
    }
    const win = createWindow({
      width: 900,
      height: 720,
      minWidth: 480,
      minHeight: 360,
      title: path.basename(filePath),
      parent: mainWindow,
    });
    previewWindows.set(key, win);
    win.on("closed", () => previewWindows.delete(key));
    loadApp(win, `?view=preview&path=${encodeURIComponent(filePath)}`);
  });

  ipcMain.handle("fs:read-file", (_event, { path: target }) => readText(target));
  ipcMain.handle("fs:write-file", async (_event, { path: target, content }) => {
    await ensureDir(path.dirname(target));
    await fsp.writeFile(target, content, "utf8");
  });
  ipcMain.handle("fs:append-file", async (_event, { path: target, content }) => {
    await ensureDir(path.dirname(target));
    await fsp.appendFile(target, content, "utf8");
  });
  ipcMain.handle("fs:create-directory", (_event, { path: target }) => ensureDir(target));
  ipcMain.handle("fs:delete-path", async (_event, { path: target }) => {
    const stat = await fsp.stat(target);
    await fsp.rm(target, { recursive: stat.isDirectory(), force: true });
  });
  ipcMain.handle("fs:list-directory", async (_event, { path: target }) => {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  });
  ipcMain.handle("fs:list-directory-entries", async (_event, { path: target }) => {
    const entries = await fsp.readdir(target, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith("."))
      .map((entry) => ({ name: entry.name, isDir: entry.isDirectory() }))
      .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  });
  ipcMain.handle("fs:exists", async (_event, { path: target }) => fs.existsSync(target));
  ipcMain.handle("fs:stat", async (_event, { path: target }) => {
    const stat = await fsp.stat(target);
    return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), isSymlink: stat.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs };
  });

  ipcMain.handle("config:read", (_event, { fileName }) => readText(configPath(fileName)));
  ipcMain.handle("config:write", (_event, { fileName, content }) => writeJsonFile(configPath(fileName), content));
  ipcMain.handle("config:list-agents", () => listJsonIds(path.join(dataDir(), "agents"), ["builtin", "custom"]));
  ipcMain.handle("config:read-agent", (_event, { agentId }) => readTypedConfig("agents", agentId));
  ipcMain.handle("config:write-agent", (_event, { agentId, content }) => writeTypedConfig("agents", agentId, content));
  ipcMain.handle("config:delete-agent", (_event, { agentId }) => deleteTypedConfig("agents", agentId));
  ipcMain.handle("config:list-mcp", () => listJsonIds(path.join(dataDir(), "mcp")));
  ipcMain.handle("config:read-mcp", (_event, { mcpId }) => readTypedConfig("mcp", mcpId));
  ipcMain.handle("config:write-mcp", (_event, { mcpId, content }) => writeTypedConfig("mcp", mcpId, content));
  ipcMain.handle("config:delete-mcp", (_event, { mcpId }) => deleteTypedConfig("mcp", mcpId));
  ipcMain.handle("config:list-teams", () => listJsonIds(path.join(dataDir(), "teams")));
  ipcMain.handle("config:read-team", (_event, { teamId }) => readTypedConfig("teams", teamId));
  ipcMain.handle("config:write-team", (_event, { teamId, content }) => writeTypedConfig("teams", teamId, content));
  ipcMain.handle("config:delete-team", (_event, { teamId }) => deleteTypedConfig("teams", teamId));
  ipcMain.handle("config:fetch-builtin-mcp", async () => {
    const dir = path.join(dataDir(), "mcp", "builtin");
    const ids = await listJsonIds(dir);
    const configs = await Promise.all(ids.map((id) => readText(path.join(dir, `${id}.json`)).then(JSON.parse)));
    return JSON.stringify(configs);
  });

  ipcMain.handle("llm:chat-completion", (_event, { request }) => chatCompletion(request));
  ipcMain.handle("llm:chat-completion-stream", (event, { request }) => chatCompletionStream(event, request));
  ipcMain.handle("llm:list-models", (_event, { request }) => listModels(request));
  ipcMain.handle("network:cors-fetch", (_event, { request }) => corsFetch(request));
  ipcMain.handle("network:web-search", (_event, { request }) => webSearch(request));
  ipcMain.handle("network:web-read", (_event, { request }) => webRead(request));
  ipcMain.handle("network:skills-market-search", (_event, { request }) => skillsMarketSearch(request));
  ipcMain.handle("network:fetch-text-prompts", fetchTextPrompts);
  ipcMain.handle("skills:list", (_event, { skillType }) => listSkills(skillType));
  ipcMain.handle("skills:read-metadata", (_event, { skillId }) => readSkillMetadata(skillId));
  ipcMain.handle("skills:install-git", (_event, { repoUrl }) => installSkillFromGit(repoUrl));
  ipcMain.handle("skills:install-local", (_event, { sourcePath }) => installSkillFromLocal(sourcePath));
  ipcMain.handle("mcp:stdio-list-tools", (_event, { server }) =>
    withStdioClient(server, async (client) => {
      const result = await client.request("tools/list", {});
      return (result.tools || []).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }),
  );
  ipcMain.handle("mcp:stdio-call-tool", (_event, { request }) =>
    withStdioClient(request.server, (client) =>
      client.request("tools/call", {
        name: request.toolName,
        arguments: request.arguments || {},
      }),
    ),
  );
}

function labelForPath(filePath) {
  let hash = 5381;
  for (let index = 0; index < filePath.length; index += 1) {
    hash = (hash * 33) ^ filePath.charCodeAt(index);
  }
  return `preview-${(hash >>> 0).toString(36)}`;
}

app.setAppUserModelId(APP_ID);
app.setName(APP_NAME);
registerHandlers();
app.whenReady().then(async () => {
  await ensureDataDir();
  createMainWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
