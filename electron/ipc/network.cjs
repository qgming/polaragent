// IPC：网络相关（跨域代理、技能广场搜索、内置助手广场、网络搜索）
const { projectResourcePath } = require("../lib/app-paths.cjs");
const { readText } = require("../lib/fs-utils.cjs");
const { normalizeWebUrl } = require("../lib/http-utils.cjs");

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

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Tavily 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Exa 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Serper 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

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

      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) continue;

      const data = await response.json();
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

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": apiKey,
    },
    signal: AbortSignal.timeout(30000),
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`Brave 搜索失败（${response.status}）：${data.error || data.message || "未知错误"}`);

  const results = (data.web?.results || []).map((item) => ({
    title: item.title || "",
    url: item.url || "",
    snippet: item.description || "",
  }));

  return { success: true, provider: "brave", results };
}

function register(ipcMain) {
  ipcMain.handle("network:cors-fetch", (_event, { request }) => corsFetch(request));
  ipcMain.handle("network:skills-market-search", (_event, { request }) => skillsMarketSearch(request));
  ipcMain.handle("network:fetch-agent-index", fetchAgentIndex);
  ipcMain.handle("network:fetch-agent-category", (_event, { fileName }) => fetchAgentCategory(fileName));
  ipcMain.handle("network:web-search", (_event, { request }) => webSearch(request));
}

module.exports = { register };
