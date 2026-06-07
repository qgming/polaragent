// IPC：网络相关（跨域代理、技能广场搜索、内置助手广场）
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

function register(ipcMain) {
  ipcMain.handle("network:cors-fetch", (_event, { request }) => corsFetch(request));
  ipcMain.handle("network:skills-market-search", (_event, { request }) => skillsMarketSearch(request));
  ipcMain.handle("network:fetch-agent-index", fetchAgentIndex);
  ipcMain.handle("network:fetch-agent-category", (_event, { fileName }) => fetchAgentCategory(fileName));
}

module.exports = { register };
