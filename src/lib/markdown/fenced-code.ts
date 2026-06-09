export function isClosedFencedCodeBlock(
  source: string,
  language: string,
  code: string,
): boolean {
  const normalizedSource = source.replace(/\r\n?/g, "\n");
  const normalizedCode = code.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  const targetLanguage = language.trim().toLowerCase();
  const fencePattern = /^([ \t]*)(`{3,}|~{3,})[ \t]*([^\n]*)\n/gm;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(normalizedSource)) !== null) {
    const [, indent, fence, info = ""] = match;
    const blockLanguage = info.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    if (blockLanguage !== targetLanguage) continue;

    const bodyStart = fencePattern.lastIndex;
    const closePattern = new RegExp(
      `^${escapeRegExp(indent)}${escapeRegExp(fence)}[ \\t]*$`,
      "gm",
    );
    closePattern.lastIndex = bodyStart;
    const closeMatch = closePattern.exec(normalizedSource);
    if (!closeMatch) {
      const remainingBody = normalizedSource.slice(bodyStart).replace(/\n$/, "");
      if (remainingBody === normalizedCode) return false;
      continue;
    }

    const body = normalizedSource
      .slice(bodyStart, closeMatch.index)
      .replace(/\n$/, "");
    if (body === normalizedCode) return true;

    fencePattern.lastIndex = closeMatch.index + closeMatch[0].length;
  }

  return false;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
