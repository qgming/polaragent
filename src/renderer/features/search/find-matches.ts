import type { ChatMessage, TextPart } from "@/shared/contracts";

/** 片段截断半径：命中词前后各保留的字符数 */
export const SNIPPET_RADIUS = 24;

/** 单条消息的命中结果 */
export interface SearchMatch {
  messageId: string;
  /** 该消息内的命中次数 */
  count: number;
  /** 首个命中周围的片段（超长时两端带省略号） */
  snippet: string;
}

/** 转义正则元字符，保证按字面量匹配（大小写不敏感交给 i 标志） */
export function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 拼接消息中的全部文本 part；推理、工具调用、图片不参与搜索 */
export function messageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

/** 截取命中词周围的片段：超出边界时加省略号，并把换行等空白折叠为单空格 */
export function buildSnippet(text: string, hitIndex: number, keywordLength: number): string {
  const start = Math.max(0, hitIndex - SNIPPET_RADIUS);
  const end = Math.min(text.length, hitIndex + keywordLength + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/** 统计命中次数并返回首个命中位置；matchAll 不修改 lastIndex */
function countOccurrences(text: string, pattern: RegExp): { count: number; firstIndex: number } {
  let count = 0;
  let firstIndex = -1;
  for (const match of text.matchAll(pattern)) {
    if (firstIndex < 0) firstIndex = match.index ?? 0;
    count += 1;
  }
  return { count, firstIndex };
}

/**
 * 会话内搜索的核心：对每条消息的文本 part 做大小写不敏感的子串匹配。
 * 只返回有命中的消息，snippet 为首个命中周围的片段。
 */
export function findMatches(messages: ChatMessage[], query: string): SearchMatch[] {
  const keyword = query.trim();
  if (!keyword) return [];

  const pattern = new RegExp(escapeRegExp(keyword), "gi");
  const matches: SearchMatch[] = [];
  for (const message of messages) {
    const text = messageText(message);
    if (!text) continue;
    const { count, firstIndex } = countOccurrences(text, pattern);
    if (count === 0) continue;
    matches.push({
      messageId: message.id,
      count,
      snippet: buildSnippet(text, firstIndex, keyword.length),
    });
  }
  return matches;
}
