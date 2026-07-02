// 最大扫描文本长度，防止超长输入导致 ReDoS 攻击
const MAX_SCAN_LENGTH = 10000;

const SENSITIVE_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|passwd|pwd)\s*[:=]\s*["']?[\w./+=-]{8,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b[A-Za-z0-9_]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  /\b\d{6}(?:19|20)?\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/,
  /\b(?:\d[ -]?){13,19}\b/,
  /验证码|verification code|one[- ]?time code|otp/i,
];

export function hasSensitiveMemoryContent(text: string): boolean {
  // 截断超长文本，防止正则回溯导致的 ReDoS 风险
  const truncated =
    text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(truncated));
}

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
