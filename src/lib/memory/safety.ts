// 记忆模块的文本处理助手
// 说明：敏感内容过滤功能已下线（v0.4.4 起由提取端提示词约束），
// 这里只保留模型输出的 JSON 规范化助手。

export function normalizeMemoryJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "[]";
  const unwrapped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  if (unwrapped.startsWith("[")) return unwrapped;

  const start = unwrapped.indexOf("[");
  const end = unwrapped.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return unwrapped.slice(start, end + 1);
  }
  return "[]";
}
