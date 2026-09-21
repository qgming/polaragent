// HTML → 纯文本。
//
// 零依赖，纯函数，可单测。
//
// 为什么不上 turndown + DOM 库：本仓库的取向是「不为一个封闭的小问题加依赖」
// （grep/glob 手写 glob 也是同一个理由）。实测 dreamagent 的正则方案对模型够用：
// 去掉 script/style/注释、优先取 article/main、块级标签转换行、解实体、压空行 ——
// 输出是可读的文本流。代价是**没有 Markdown 结构**（表格与代码块退化成普通文本），
// 这是明确接受的取舍；升级点是局部的（只改本文件），服务层与工具层不受影响。
//
// 相对 dreamagent 的 extractWebPageText 补三处防御：
//   1. **输入上限**：先 slice 再处理，避免几 MB 的页面把主线程占住；
//   2. **规模守卫**：标签数超上限时直接放弃转换，回固定省略标记 ——
//      正则在病态输入上会回溯爆炸，而转换是同步的（超时定时器那时打不着）；
//   3. **输出设界**：截断时保证调用方能看出「被截了」（truncated 标志）。

/** 参与转换的源字符上限（超出部分直接丢弃） */
export const MAX_INPUT_CHARS = 2_000_000;

/** 无法安全转换时的固定标记（与 dsh 同款：不返回原始 HTML） */
export const OMITTED_MARKER = "[HTML content omitted: unable to convert safely.]";

export interface ExtractedPage {
  title: string;
  content: string;
  /** 转换前的正文字符数（截断前），供调用方报告「原文 N 字」 */
  textLength: number;
  truncated: boolean;
}

/** 实体解码：只处理最常见的几种 + 数字实体（完整 HTML 实体表不值得内置） */
export function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, code: string) => safeFromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      safeFromCodePoint(Number.parseInt(code, 16)),
    );
}

/** 码点 → 字符；越界或非法时回原样（不要抛，坏实体不该毁掉整页） */
function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** 去标签：把标签替换成空格，避免 `<b>a</b><i>b</i>` 粘成 `ab` */
function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, " ");
}

/**
 * 取出 `<title>` 或 `og:title`。
 *
 * og:title 优先：它是站点自己声明的「分享标题」，通常比 `<title>` 干净
 * （后者常带「- 站点名」这类后缀）。
 *
 * og:title 的**属性顺序不固定**（`property` 在 `content` 前后都合法），
 * 所以先定位出所有 `<meta ...>`，再逐个检查它是不是 og:title ——
 * 一条「property 在前、content 在后」的正则会漏掉另一种写法。
 */
function extractTitle(html: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/property\s*=\s*["']og:title["']/i.test(tag)) continue;
    const content = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const text = content === undefined ? "" : decodeEntities(content).trim();
    if (text !== "") return text;
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (title?.[1] !== undefined) {
    const text = decodeEntities(stripTags(title[1])).replace(/\s+/g, " ").trim();
    if (text !== "") return text;
  }
  return "";
}

/**
 * 标签数上限。
 *
 * 保留它作为「明显不是网页」的粗判据：正常页面的标签数在几千到几万量级。
 * 去掉转换的年代它只影响下游成本，**不再承担防卡死的职责**（那是 dropNonContent 的线性保证）。
 */
export const MAX_TAG_COUNT = 300_000;

/** 粗略统计标签数 */
function countTags(html: string): number {
  let count = 0;
  let index = html.indexOf("<");
  while (index !== -1) {
    count += 1;
    if (count > MAX_TAG_COUNT) return count;
    index = html.indexOf("<", index + 1);
  }
  return count;
}

/** 需要整块丢弃的元素（开标签前缀 + 对应闭标签前缀） */
const DROPPED_ELEMENTS: readonly { open: string; close: string }[] = [
  { open: "<script", close: "</script" },
  { open: "<style", close: "</style" },
  { open: "<noscript", close: "</noscript" },
  { open: "<template", close: "</template" },
  { open: "<svg", close: "</svg" },
  { open: "<head", close: "</head" },
];

/** 标签名之后允许出现的字符（区分 `<script>` 与 `<scriptfoo>`） */
function isTagNameBoundary(char: string | undefined): boolean {
  return char === undefined || char === ">" || char === "/" || /\s/.test(char);
}

/**
 * 一次线性扫描，丢掉不承载正文的整块内容（script / style / 注释 / head / svg …）。
 *
 * **为什么不用 `/<script[\s\S]*?<\/script>/g`**：没有闭合标签时它会一路扫到输入末尾，
 * N 个未闭合的 `<script>` 就是 N 次全量扫描 —— O(n²)。实测 2MB 输入下未闭合注释洪水要
 * 2.2 秒，而转换是**同步**的，那期间工具的超时定时器根本打不着，表现就是「应用卡住」。
 *
 * 也试过「先检查开闭标签配平」的守卫，但**它在真实页面上是错的**：
 * nodejs.org 的 HTML 里 `-->` 出现 18 次而 `<!--` 一次都没有 —— 那些是 JavaScript 里的
 * 自减运算符（`i-->0`），不是注释。按子串计数会把正常页面误判成畸形而整体放弃提取。
 *
 * 单遍扫描从根上解决：无论输入多畸形，代价都是 O(n)；
 * 未闭合的块就是「吃掉剩余全部」—— 既安全，也符合直觉。
 */
export function dropNonContent(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let index = 0;

  while (index < html.length) {
    const lt = html.indexOf("<", index);
    if (lt === -1) {
      parts.push(html.slice(index));
      break;
    }
    parts.push(html.slice(index, lt));

    // 注释：吃到 `-->`；未闭合就吃到末尾（后面的内容是注释碎片，没有正文价值）
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      if (end === -1) break;
      index = end + 3;
      continue;
    }

    // 整块丢弃的元素：从开标签吃到闭标签之后
    const dropped = DROPPED_ELEMENTS.find(
      (element) =>
        lower.startsWith(element.open, lt) && isTagNameBoundary(lower[lt + element.open.length]),
    );
    if (dropped !== undefined) {
      const closeAt = lower.indexOf(dropped.close, lt + dropped.open.length);
      // 未闭合：剩余内容都属于这个块（或输入本身畸形）
      if (closeAt === -1) break;
      const gt = html.indexOf(">", closeAt + dropped.close.length);
      index = gt === -1 ? html.length : gt + 1;
      continue;
    }

    // 普通标签：保留 `<`（后续 stripTags 统一处理），只跳过这一个字符
    parts.push("<");
    index = lt + 1;
  }

  return parts.join("");
}

/**
 * HTML → 正文文本。
 *
 * @param html 原始 HTML（调用方已按 Content-Type 判定为 html）
 * @param maxChars 正文最大字符数
 */
export function extractPageText(html: string, maxChars: number): ExtractedPage {
  // 1) 输入上限：先切再处理，避免后面所有正则在巨型输入上跑
  const input = html.length > MAX_INPUT_CHARS ? html.slice(0, MAX_INPUT_CHARS) : html;

  // 2) 规模守卫：标签太密说明不是普通网页
  if (countTags(input) > MAX_TAG_COUNT) {
    return { title: extractTitle(input), content: OMITTED_MARKER, textLength: 0, truncated: true };
  }

  const title = extractTitle(input);

  // 3) 丢掉不承载正文的元素（单遍线性扫描，见 dropNonContent 的说明）
  const body = dropNonContent(input);

  // 4) 优先取更窄的正文容器：article / main 比 body 少大量导航与页脚噪声
  const scoped =
    body.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    body.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    body.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    body;

  // 5) 块级元素转换行（在去标签之前做，否则换行位置就丢了）
  const withBreaks = scoped
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|figure|figcaption|nav|aside|form)\s*>/gi,
      "\n",
    );

  // 6) 去标签 → 解实体 → 归一空白
  const text = decodeEntities(stripTags(withBreaks))
    .split("\n")
    // 行内空白归一：HTML 源码里的缩进与换行不是排版意图
    .map((line) => line.replace(/[ \t\r\f\v\u00a0]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n")
    // 三个以上连续换行压成两个（保留段落感，去掉大段空白）
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const textLength = text.length;
  const truncated = textLength > maxChars;
  return {
    title,
    content: truncated ? text.slice(0, maxChars) : text,
    textLength,
    truncated,
  };
}
