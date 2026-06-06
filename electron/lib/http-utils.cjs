// 主进程网络/HTTP 共享工具：URL 归一化、HTML 解析、实体解码等。
const { DEFAULT_SEARCH_INSTANCES } = require("./constants.cjs");

// 归一化 LLM Base URL：去尾斜杠，确保以 /v1 结尾
function normalizeBaseUrl(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Base URL 不能为空");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// 从错误响应体提取人类可读错误信息
function errorMessage(payload) {
  return payload?.error?.message || payload?.message || "服务返回错误";
}

// 编码 query 组件（同时转义 RFC3986 保留字符）
function encodeQueryComponent(input) {
  return encodeURIComponent(input).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// 解码常见 HTML 实体
function decodeEntities(input) {
  return input
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// 去除 HTML 标签并压缩空白
function stripTags(input) {
  return decodeEntities(String(input).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim());
}

// 从 SearXNG HTML 结果页解析搜索条目
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

// 归一化用户输入的 Web URL（补 https，仅允许 http/https）
function normalizeWebUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) throw new Error("url 不能为空");
  const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  if (!/^https?:\/\//i.test(url)) throw new Error("仅支持 http/https URL");
  return url;
}

// 判定内容是否疑似被反爬/验证码拦截
function looksBlocked(content) {
  return /captcha|not a bot|cloudflare|access denied|verify you are human|人机验证|安全验证/i.test(content);
}

// 判定内容是否疑似 HTML
function looksHtml(content) {
  return /<html|<body|<!doctype html/i.test(content.slice(0, 2000));
}

// 提取 <title>
function extractTitle(html) {
  const match = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : undefined;
}

// 从 HTML 粗提取可读正文
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

module.exports = {
  DEFAULT_SEARCH_INSTANCES,
  normalizeBaseUrl,
  errorMessage,
  encodeQueryComponent,
  decodeEntities,
  stripTags,
  parseHtmlResults,
  normalizeWebUrl,
  looksBlocked,
  looksHtml,
  extractTitle,
  extractReadable,
};
