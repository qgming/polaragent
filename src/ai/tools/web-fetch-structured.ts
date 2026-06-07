// 网页结构化抽取辅助 —— 空白归一、链接与表格提取
// src/ai/tools/web-fetch-structured.ts
//
// 在渲染进程（浏览器环境）中对解析后的 DOM 做结构化抽取，供 web_fetch 工具复用。
// 仅依赖渲染进程原生可用的 DOM 与 URL API。

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
