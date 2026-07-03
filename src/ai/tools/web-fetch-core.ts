// 网页内容解析核心 —— HTML 解析、正文提取、结构化抽取
// src/ai/tools/web-fetch-core.ts
//
// 在渲染进程（浏览器环境）用 DOMParser 解析 HTML，剔除噪声节点，
// 收集正文块（标题/段落/列表等），并支持三种提取模式：
//   full          —— 全文
//   heading_range —— 按标题及其下属层级截取一段
//   anchor_range  —— 以命中锚点的正文块为中心，前后扩展若干块
// 同时提供结构化抽取能力：链接、表格。
// 仅依赖渲染进程原生可用的 DOMParser 与 URL API。

// ============================================================
// 结构化抽取：类型定义与辅助函数
// ============================================================

// 页面链接：文本 + 绝对地址
export interface WebFetchLink {
  text: string;
  url: string;
}

// 页面表格：可选标题 + 表头 + 数据行
export interface WebFetchTable {
  caption?: string;
  headers: string[];
  rows: string[][];
}

// 把连续空白折叠为单个空格并去除首尾空白
export function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

// 把相对链接解析为绝对地址；仅保留 http/https，其余返回 null
function resolveLinkUrl(href: string, pageUrl: string) {
  try {
    const url = new URL(href, pageUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

// 提取根节点下的所有有效链接（按绝对地址去重）
export function extractLinks(root: HTMLElement, pageUrl: string) {
  const seen = new Set<string>();
  return Array.from(root.querySelectorAll("a[href]")).flatMap(
    (node): WebFetchLink[] => {
      const href = node.getAttribute("href")?.trim();
      const url = href ? resolveLinkUrl(href, pageUrl) : null;
      if (!url || seen.has(url)) {
        return [];
      }
      seen.add(url);
      return [{ text: normalizeWhitespace(node.textContent ?? "") || url, url }];
    },
  );
}

// 提取一行中的单元格文本（去空）
function extractRowCells(row: Element) {
  return Array.from(row.querySelectorAll("th, td"))
    .map((cell) => normalizeWhitespace(cell.textContent ?? ""))
    .filter(Boolean);
}

// 提取根节点下的所有表格（区分表头与数据行）
export function extractTables(root: HTMLElement) {
  return Array.from(root.querySelectorAll("table")).flatMap(
    (table): WebFetchTable[] => {
      const rows = Array.from(table.querySelectorAll("tr"));
      if (rows.length === 0) {
        return [];
      }

      const headerRow =
        table.querySelector("thead tr")
        ?? rows.find((row) => row.querySelector("th"))
        ?? null;
      const headers = headerRow ? extractRowCells(headerRow) : [];
      const dataRows = rows
        .filter((row) => row !== headerRow)
        .map(extractRowCells)
        .filter((cells) => cells.length > 0);
      const caption = normalizeWhitespace(
        table.querySelector("caption")?.textContent ?? "",
      );

      return headers.length > 0 || dataRows.length > 0
        ? [{ caption: caption || undefined, headers, rows: dataRows }]
        : [];
    },
  );
}

// ============================================================
// 正文提取：类型定义与核心逻辑
// ============================================================

// 摘要片段长度（用于 details.excerpt）
const EXCERPT_CHARS = 280;

export type WebFetchMode = "anchor_range" | "full" | "heading_range";

// 提取选项：模式、分段定位参数与结构化抽取开关
export type WebFetchExtractOptions = {
  afterBlocks?: number;
  anchor?: string;
  beforeBlocks?: number;
  caseSensitive?: boolean;
  heading?: string;
  includeLinks?: boolean;
  includeTables?: boolean;
  mode?: WebFetchMode;
  occurrence?: number;
};

// 正文块：标题或普通文本
type WebContentBlock = {
  kind: "heading" | "text";
  level?: number;
  text: string;
};

// 超长文本截断，并标记是否被截断
function truncateText(value: string, maxChars: number) {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }

  return {
    text: `${normalized.slice(0, maxChars).trimEnd()}…`,
    truncated: true,
  };
}

// 移除脚本、样式、导航、广告等对正文无意义的噪声节点
function removeNoiseNodes(root: ParentNode) {
  root
    .querySelectorAll(
      [
        "script",
        "style",
        "noscript",
        "svg",
        "canvas",
        "form",
        "button",
        "input",
        "select",
        "textarea",
        "nav",
        "footer",
        "header",
        "aside",
        "iframe",
        "[aria-hidden='true']",
        ".advertisement",
        ".ads",
        ".sidebar",
      ].join(","),
    )
    .forEach((node) => node.remove());
}

// 选择正文根节点：优先 article/main 等语义容器，回退到 body
function chooseContentRoot(document: Document) {
  const candidates = [
    document.querySelector("article"),
    document.querySelector("main"),
    document.querySelector("[role='main']"),
    document.querySelector(".article"),
    document.querySelector(".article-content"),
    document.querySelector(".content"),
    document.body,
  ];

  return candidates.find((candidate): candidate is HTMLElement => Boolean(candidate))
    ?? document.body;
}

// 归一化标题查询：去掉前导的 Markdown "#"
function normalizeHeadingQuery(heading: string) {
  return heading.trim().replace(/^#+\s*/, "");
}

// 按是否区分大小写归一化文本
function normalizeText(value: string, caseSensitive: boolean) {
  return caseSensitive ? value : value.toLocaleLowerCase();
}

// 收集正文块：标题保留层级，正文要求至少 20 字符；全空时回退为整段文本
function collectContentBlocks(root: HTMLElement) {
  const blocks = Array.from(
    root.querySelectorAll("h1, h2, h3, h4, p, li, blockquote, pre"),
  ).flatMap((node): WebContentBlock[] => {
    const text = normalizeWhitespace(node.textContent ?? "");
    if (!text) {
      return [];
    }

    const headingMatch = node.tagName.match(/^H([1-4])$/i);
    if (headingMatch) {
      return [{
        kind: "heading",
        level: Number.parseInt(headingMatch[1], 10),
        text,
      }];
    }

    return text.length >= 20 ? [{ kind: "text", text }] : [];
  });

  if (blocks.length > 0) {
    return blocks;
  }

  const fallback = normalizeWhitespace(root.textContent ?? "");
  return fallback ? [{ kind: "text" as const, text: fallback }] : [];
}

// 找到满足谓词的第 N 个块的下标；找不到返回 -1
function findNthBlockIndex(
  blocks: WebContentBlock[],
  predicate: (block: WebContentBlock) => boolean,
  occurrence: number,
) {
  let currentOccurrence = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    if (!predicate(blocks[index])) {
      continue;
    }
    currentOccurrence += 1;
    if (currentOccurrence === occurrence) {
      return index;
    }
  }

  return -1;
}

// 解析锚点窗口：以命中锚点的块为中心，向前后各扩展若干块
function resolveAnchorWindow(params: {
  afterBlocks: number;
  anchor: string;
  beforeBlocks: number;
  blocks: WebContentBlock[];
  caseSensitive: boolean;
  occurrence: number;
}) {
  const normalizedAnchor = normalizeText(params.anchor, params.caseSensitive);
  const anchorIndex = findNthBlockIndex(
    params.blocks,
    (block) =>
      normalizeText(block.text, params.caseSensitive).includes(normalizedAnchor),
    params.occurrence,
  );

  if (anchorIndex < 0) {
    throw new Error(`未找到第 ${params.occurrence} 处包含指定 anchor 的正文块。`);
  }

  return {
    endIndex: Math.min(anchorIndex + params.afterBlocks + 1, params.blocks.length),
    startIndex: Math.max(anchorIndex - params.beforeBlocks, 0),
  };
}

// 解析标题窗口：从命中标题起，到下一个同级或更高级标题前结束
function resolveHeadingWindow(blocks: WebContentBlock[], heading: string, occurrence: number) {
  const normalizedHeading = normalizeHeadingQuery(heading);
  const headingIndex = findNthBlockIndex(
    blocks,
    (block) => block.kind === "heading" && block.text === normalizedHeading,
    occurrence,
  );

  if (headingIndex < 0) {
    throw new Error(`未找到标题"${normalizedHeading}"。`);
  }

  const currentHeading = blocks[headingIndex];
  let endIndex = blocks.length;
  for (let index = headingIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.kind === "heading" && (block.level ?? 6) <= (currentHeading.level ?? 6)) {
      endIndex = index;
      break;
    }
  }

  return { endIndex, startIndex: headingIndex };
}

// 根据模式解析选中的正文块窗口区间
function resolveSelectedBlockWindow(
  blocks: WebContentBlock[],
  options?: WebFetchExtractOptions,
) {
  const mode = options?.mode ?? "full";
  if (mode === "anchor_range") {
    const anchor = options?.anchor?.trim();
    if (!anchor) {
      throw new Error("web_fetch.anchor_range 需要提供 anchor。");
    }

    return resolveAnchorWindow({
      afterBlocks: Math.max(options?.afterBlocks ?? 2, 0),
      anchor,
      beforeBlocks: Math.max(options?.beforeBlocks ?? 2, 0),
      blocks,
      caseSensitive: Boolean(options?.caseSensitive),
      occurrence: Math.max(options?.occurrence ?? 1, 1),
    });
  }

  if (mode === "heading_range") {
    const heading = options?.heading?.trim();
    if (!heading) {
      throw new Error("web_fetch.heading_range 需要提供 heading。");
    }
    return resolveHeadingWindow(blocks, heading, Math.max(options?.occurrence ?? 1, 1));
  }

  return { endIndex: blocks.length, startIndex: 0 };
}

// 把正文块渲染为以空行分隔的纯文本
function renderBlocks(blocks: WebContentBlock[]) {
  return blocks.map((block) => block.text).join("\n\n").trim();
}

// 抽取网页内容：解析 HTML → 选根节点 → 收集块 → 按模式截取 → 截断 + 可选结构化抽取
export function extractWebPageContent(
  html: string,
  maxChars: number,
  pageUrl: string,
  options?: WebFetchExtractOptions,
) {
  const parser = new DOMParser();
  const document = parser.parseFromString(html, "text/html");
  removeNoiseNodes(document);

  const title =
    normalizeWhitespace(
      document.querySelector("meta[property='og:title']")?.getAttribute("content")
        ?? document.title,
    )
    || "未命名网页";
  const root = chooseContentRoot(document);
  const contentBlocks = collectContentBlocks(root);
  const { endIndex, startIndex } = resolveSelectedBlockWindow(contentBlocks, options);
  const selectedBlocks = contentBlocks.slice(startIndex, endIndex);
  const fullContent = renderBlocks(selectedBlocks);
  const truncated = truncateText(fullContent, maxChars);

  return {
    content: truncated.text,
    excerpt: truncateText(fullContent, EXCERPT_CHARS).text,
    links: options?.includeLinks ? extractLinks(root, pageUrl) : undefined,
    mode: options?.mode ?? "full",
    selectedBlockCount: selectedBlocks.length,
    selectedBlockEnd: endIndex,
    selectedBlockStart: startIndex + 1,
    tables: options?.includeTables ? extractTables(root) : undefined,
    textLength: fullContent.length,
    title,
    truncated: truncated.truncated,
  };
}
