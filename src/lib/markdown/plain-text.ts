/**
 * Convert markdown to readable plain text for copy actions.
 * This is intentionally pragmatic rather than a full markdown parser.
 */
export function stripMarkdown(markdown: string): string {
  let text = markdown;

  text = text.replace(/^```[^\n]*\n?/gm, "").replace(/^```$/gm, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(\*|_)(.*?)\1/g, "$2");
  text = text.replace(/~~(.*?)~~/g, "$1");

  text = text
    .split("\n")
    .map((line) => {
      let next = line;
      next = next.replace(/^\s{0,3}#{1,6}\s+/, "");
      next = next.replace(/^\s{0,3}>\s?/, "");
      next = next.replace(/^\s*[-*+]\s+/, "");
      next = next.replace(/^\s*\d+[.)]\s+/, "");

      if (/^\s*\|.*\|\s*$/.test(next)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(next)) {
          return "";
        }
        next = next
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((cell) => cell.trim())
          .join("  ");
      }

      return next;
    })
    .join("\n");

  text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, "");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
