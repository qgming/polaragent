const FENCE_PREFIX_PATTERN = /^```(?:json|text)?\s*/i;
const FENCE_SUFFIX_PATTERN = /\s*```$/;

type JsonRecord = Record<string, unknown>;

export function unwrapStructuredOutput(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  return trimmed
    .replace(FENCE_PREFIX_PATTERN, "")
    .replace(FENCE_SUFFIX_PATTERN, "")
    .trim();
}

export function parseJsonObjectCandidates(raw: string): JsonRecord[] {
  const candidates: JsonRecord[] = [];
  const seen = new Set<string>();

  for (const text of collectCandidateTexts(raw)) {
    pushParsedObject(candidates, seen, text);

    for (const segment of extractBalancedSegments(text, "{", "}")) {
      pushParsedObject(candidates, seen, segment);
    }
  }

  return candidates;
}

export function extractLastLabeledValue(raw: string, labels: string[]): string | null {
  const normalizedLabels = labels
    .map((label) => label.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (normalizedLabels.length === 0) return null;

  const labelPattern = normalizedLabels.map(escapeRegExp).join("|");
  const patterns = [
    new RegExp(`(?:["']?(?:${labelPattern})["']?)\\s*[:：=]\\s*"([^"\\r\\n]+)"`, "gi"),
    new RegExp(`(?:["']?(?:${labelPattern})["']?)\\s*[:：=]\\s*'([^'\\r\\n]+)'`, "gi"),
    new RegExp(`(?:["']?(?:${labelPattern})["']?)\\s*[:：=]\\s*([^\\r\\n,}]+)`, "gi"),
  ];

  let lastMatch: string | null = null;
  for (const text of collectCandidateTexts(raw)) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const value = match[1]?.trim();
        if (value) lastMatch = value;
      }
    }
  }

  return lastMatch;
}

export function extractLabeledBoolean(raw: string, labels: string[]): boolean | null {
  const value = extractLastLabeledValue(raw, labels);
  return normalizeLooseBoolean(value);
}

export function normalizeLooseBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;

  const normalized = value
    .toLowerCase()
    .replace(/[\[\]{}()"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;

  const falsePatterns = [
    /^false\b/,
    /^deny\b/,
    /^denied\b/,
    /^reject\b/,
    /^rejected\b/,
    /^block(?:ed)?\b/,
    /^forbid(?:den)?\b/,
    /^refuse\b/,
    /^no\b/,
    /^不允许/,
    /^拒绝/,
    /^阻止/,
    /^禁止/,
    /^拦截/,
  ];
  if (falsePatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const truePatterns = [
    /^true\b/,
    /^allow(?:ed)?\b/,
    /^approve(?:d)?\b/,
    /^permit(?:ted)?\b/,
    /^yes\b/,
    /^ok\b/,
    /^允许/,
    /^可执行/,
    /^通过/,
    /^放行/,
    /^同意/,
    /^批准/,
  ];
  if (truePatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  return null;
}

function collectCandidateTexts(raw: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    results.push(trimmed);
  };

  push(raw);
  push(unwrapStructuredOutput(raw));
  return results;
}

function pushParsedObject(target: JsonRecord[], seen: Set<string>, text: string): void {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;

    const signature = JSON.stringify(parsed);
    if (seen.has(signature)) return;
    seen.add(signature);
    target.push(parsed as JsonRecord);
  } catch {
    // 忽略无效 JSON，继续走规则提取兜底。
  }
}

function extractBalancedSegments(
  source: string,
  openChar: "{" | "[",
  closeChar: "}" | "]",
  limit = 8,
): string[] {
  const segments: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        inString = false;
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      continue;
    }

    if (char === openChar) {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }

    if (char === closeChar && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        segments.push(source.slice(start, index + 1));
        start = -1;
        if (segments.length >= limit) break;
      }
    }
  }

  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
