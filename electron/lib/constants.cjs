// 主进程共享常量
const APP_ID = "com.qgming.polaragent";
const APP_NAME = "PolarAgent";
const MCP_PROTOCOL_VERSION = "2025-11-25";

// 默认 SearXNG 搜索实例
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

// Markdown 阅读代理（按顺序回退）
const MARKDOWN_READ_PROXIES = [
  "https://r.jina.ai/",
  "https://markdown.new/",
  "https://defuddle.md/",
];

module.exports = {
  APP_ID,
  APP_NAME,
  MCP_PROTOCOL_VERSION,
  DEFAULT_SEARCH_INSTANCES,
  MARKDOWN_READ_PROXIES,
};
