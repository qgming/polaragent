/**
 * Convert common LaTeX math delimiters into remark-math delimiters.
 *
 * \(...\) -> $...$
 * \[...\] -> $$...$$
 *
 * Fenced code blocks and inline code spans are preserved unchanged.
 */
export function convertLatexDelimiters(text: string): string {
  const parts: string[] = [];
  let position = 0;
  const codePattern = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/g;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(text)) !== null) {
    if (match.index > position) {
      parts.push(replaceMathDelimiters(text.slice(position, match.index)));
    }
    parts.push(match[0]);
    position = match.index + match[0].length;
  }

  if (position < text.length) {
    parts.push(replaceMathDelimiters(text.slice(position)));
  }

  return parts.join("");
}

function replaceMathDelimiters(text: string): string {
  return text
    .replace(/\\\[([\s\S]*?)\\\]/g, (_match, content: string) => `$$${content}$$`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_match, content: string) => `$${content}$`);
}
