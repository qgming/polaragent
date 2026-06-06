// IPC：网络相关（网页搜索、网页阅读、跨域代理、技能广场搜索、内置助手广场）
const { projectResourcePath } = require("../lib/app-paths.cjs");
const { readText } = require("../lib/fs-utils.cjs");
const { MARKDOWN_READ_PROXIES } = require("../lib/constants.cjs");
const {
  DEFAULT_SEARCH_INSTANCES,
  encodeQueryComponent,
  parseHtmlResults,
  normalizeWebUrl,
  looksBlocked,
  looksHtml,
  extractTitle,
  extractReadable,
} = require("../lib/http-utils.cjs");

// 搜索实例轮询状态（带冷却）
const searchState = {
  signature: "",
  instances: [],
  nextIndex: 0,
};

// 根据传入实例列表（或默认）刷新轮询状态
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

// 选出当前可用（未冷却）的实例索引列表
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

// 网页搜索（轮询多个 SearXNG 实例，失败的进入冷却）
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

// 把阅读结果裁剪到 maxChars
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

// 经 Markdown 代理读取网页
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

// 直连读取网页并提取正文
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

// 网页阅读：默认代理优先，失败回退直连
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
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`技能广场请求失败（${response.status}）：${body}`);
  return body;
}

// 读取内置助手广场 JSON
async function fetchTextPrompts() {
  const source = projectResourcePath("resources", "market", "agents", "agents-zh.json");
  if (!source) throw new Error("未找到内置助手广场 JSON：resources/market/agents/agents-zh.json");
  return readText(source);
}

function register(ipcMain) {
  ipcMain.handle("network:cors-fetch", (_event, { request }) => corsFetch(request));
  ipcMain.handle("network:web-search", (_event, { request }) => webSearch(request));
  ipcMain.handle("network:web-read", (_event, { request }) => webRead(request));
  ipcMain.handle("network:skills-market-search", (_event, { request }) => skillsMarketSearch(request));
  ipcMain.handle("network:fetch-text-prompts", fetchTextPrompts);
}

module.exports = { register };
