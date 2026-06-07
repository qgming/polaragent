// 网页读取工具 —— web_fetch
// src/ai/tools/web-fetch.ts
//
// 通过主进程的跨域代理（network:cors-fetch）拉取网页 HTML，
// 在渲染进程用 DOMParser 解析并抽取正文，支持三种提取模式：
//   full          —— 全文（默认）
//   heading_range —— 按标题截取一段
//   anchor_range  —— 以锚点为中心前后扩展若干块
// 可选附带页面链接与表格的结构化抽取。请求与超时由主进程统一处理。

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";

import { corsFetch } from "@/lib/electron/electron-api";
import { text, type ToolContext } from "./tool-context";
import {
  extractWebPageContent,
  type WebFetchExtractOptions,
  type WebFetchMode,
} from "./web-fetch-extraction";
import type { WebFetchLink, WebFetchTable } from "./web-fetch-structured";

// 默认与上限正文字符数（防止模型给出过大值压垮上下文）
const DEFAULT_MAX_CHARS = 8_000;
const MIN_ALLOWED_CHARS = 500;
const MAX_ALLOWED_CHARS = 20_000;
// 拉取网页的超时（毫秒），交由主进程 corsFetch 执行
const FETCH_TIMEOUT_MS = 30_000;

// 网页读取结果（成功时携带正文与结构化抽取，失败时携带 error）
interface WebFetchResult {
  success: boolean;
  url: string;
  title: string;
  content: string;
  excerpt: string;
  error?: string;
  links?: WebFetchLink[];
  tables?: WebFetchTable[];
  mode: WebFetchMode;
  selectedBlockCount?: number;
  selectedBlockEnd?: number;
  selectedBlockStart?: number;
  textLength: number;
  truncated: boolean;
}

// 模拟常见浏览器的请求头，提升抓取成功率
function buildRequestHeaders() {
  return {
    Accept: "text/html,application/xhtml+xml",
    "Cache-Control": "no-cache",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };
}

// 构造失败结果
function createFailure(url: string, error: string, title = ""): WebFetchResult {
  return {
    success: false,
    url,
    title,
    content: "",
    error,
    excerpt: "",
    mode: "full",
    textLength: 0,
    truncated: false,
  };
}

// 拉取并抽取网页内容
async function fetchWebPage(
  url: string,
  maxChars: number,
  options: WebFetchExtractOptions,
): Promise<WebFetchResult> {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return createFailure(url, "URL 不能为空");
  }

  const safeMaxChars = Math.min(
    Math.max(maxChars, MIN_ALLOWED_CHARS),
    MAX_ALLOWED_CHARS,
  );

  try {
    const response = await corsFetch({
      headers: buildRequestHeaders(),
      method: "GET",
      url: normalizedUrl,
      timeoutMs: FETCH_TIMEOUT_MS,
    });

    if (response.status < 200 || response.status >= 300) {
      return createFailure(normalizedUrl, `HTTP ${response.status}`);
    }

    const extracted = extractWebPageContent(
      response.body,
      safeMaxChars,
      normalizedUrl,
      options,
    );
    if (!extracted.content) {
      return createFailure(
        normalizedUrl,
        "网页正文提取失败或内容为空",
        extracted.title,
      );
    }

    return {
      success: true,
      url: normalizedUrl,
      title: extracted.title,
      content: extracted.content,
      excerpt: extracted.excerpt,
      links: extracted.links,
      tables: extracted.tables,
      mode: extracted.mode,
      selectedBlockCount: extracted.selectedBlockCount,
      selectedBlockEnd: extracted.selectedBlockEnd,
      selectedBlockStart: extracted.selectedBlockStart,
      textLength: extracted.textLength,
      truncated: extracted.truncated,
    };
  } catch (error) {
    return createFailure(
      normalizedUrl,
      error instanceof Error ? error.message : "网页读取失败",
    );
  }
}

// 拼装返回给模型的摘要句（正文随后另行附上）
function formatSummary(result: WebFetchResult) {
  return [
    `已读取网页《${result.title || "未命名网页"}》。`,
    result.mode && result.mode !== "full" ? `提取模式：${result.mode}。` : null,
    `正文长度：${result.textLength} 字符。`,
    result.links ? `结构化链接：${result.links.length} 条。` : null,
    result.tables ? `结构化表格：${result.tables.length} 个。` : null,
    result.truncated ? "当前结果已按 maxChars 裁剪。" : "当前结果为完整抽取正文。",
  ]
    .filter(Boolean)
    .join(" ");
}

// web_fetch 参数 schema
const readWebPageParams = Type.Object({
  url: Type.String({
    description: "要读取的网页地址（支持 http(s)，缺省协议时自动补 https）",
  }),
  mode: Type.Optional(
    Type.Union(
      [
        Type.Literal("full"),
        Type.Literal("heading_range"),
        Type.Literal("anchor_range"),
      ],
      {
        description:
          "提取模式：full 全文（默认）；heading_range 按标题截取一段（需 heading）；anchor_range 以锚点为中心前后扩展（需 anchor）",
      },
    ),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "正文最大字符数，500-20000，默认 8000",
      minimum: MIN_ALLOWED_CHARS,
      maximum: MAX_ALLOWED_CHARS,
    }),
  ),
  heading: Type.Optional(
    Type.String({ description: "heading_range 模式：要定位的标题文本" }),
  ),
  anchor: Type.Optional(
    Type.String({ description: "anchor_range 模式：正文中要定位的关键词" }),
  ),
  beforeBlocks: Type.Optional(
    Type.Number({ description: "anchor_range：锚点之前保留的正文块数，默认 2", minimum: 0 }),
  ),
  afterBlocks: Type.Optional(
    Type.Number({ description: "anchor_range：锚点之后保留的正文块数，默认 2", minimum: 0 }),
  ),
  occurrence: Type.Optional(
    Type.Number({ description: "命中第几处标题/锚点（从 1 开始），默认 1", minimum: 1 }),
  ),
  caseSensitive: Type.Optional(
    Type.Boolean({ description: "anchor 匹配是否区分大小写，默认 false" }),
  ),
  includeLinks: Type.Optional(
    Type.Boolean({ description: "是否额外抽取页面链接，默认 false" }),
  ),
  includeTables: Type.Optional(
    Type.Boolean({ description: "是否额外抽取页面表格，默认 false" }),
  ),
});

export function readWebPageTool(
  _ctx: ToolContext,
): AgentTool<typeof readWebPageParams> {
  return {
    name: "web_fetch",
    label: "网页读取",
    description:
      "读取网页正文并提取主要文本。默认抽取全文；可用 mode=heading_range 按标题取一段，" +
      "或 mode=anchor_range 以关键词为中心截取附近内容。适合在搜索后深入阅读某个页面。",
    parameters: readWebPageParams,
    execute: async (_id, params: Static<typeof readWebPageParams>) => {
      const mode: WebFetchMode =
        params.mode === "heading_range" || params.mode === "anchor_range"
          ? params.mode
          : "full";

      const options: WebFetchExtractOptions = {
        mode,
        afterBlocks: params.afterBlocks,
        anchor: params.anchor?.trim() || undefined,
        beforeBlocks: params.beforeBlocks,
        caseSensitive: Boolean(params.caseSensitive),
        heading: params.heading?.trim() || undefined,
        includeLinks: Boolean(params.includeLinks),
        includeTables: Boolean(params.includeTables),
        occurrence: params.occurrence,
      };

      const result = await fetchWebPage(
        params.url,
        typeof params.maxChars === "number" && Number.isFinite(params.maxChars)
          ? Math.trunc(params.maxChars)
          : DEFAULT_MAX_CHARS,
        options,
      );

      if (!result.success) {
        return {
          content: text(
            `网页读取失败：${result.error ?? "未知错误"}。请确认 URL 含 http(s) 且可公开访问；` +
              "可先用 web_search 重新查找链接，或改用 mode=full 重试。",
          ),
          details: { url: result.url, error: result.error, mode },
        };
      }

      return {
        content: text(`${formatSummary(result)}\n\n${result.content}`),
        details: {
          success: true,
          url: result.url,
          title: result.title,
          mode: result.mode,
          textLength: result.textLength,
          truncated: result.truncated,
          selectedBlockStart: result.selectedBlockStart,
          selectedBlockEnd: result.selectedBlockEnd,
          selectedBlockCount: result.selectedBlockCount,
          links: result.links,
          tables: result.tables,
        },
      };
    },
  };
}
