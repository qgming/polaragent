import { convertLatexDelimiters } from "./latex-delimiters";

export interface NormalizeMarkdownOptions {
  convertLatex?: boolean;
  stripFileProtocol?: boolean;
  rewriteExternalMediaUrls?: boolean;
  encodeHtmlMediaAttributes?: boolean;
}

export function normalizeMarkdownContent(
  content: string,
  options: NormalizeMarkdownOptions = {},
): string {
  const {
    convertLatex = true,
    stripFileProtocol = false,
    rewriteExternalMediaUrls = false,
    encodeHtmlMediaAttributes = false,
  } = options;

  let normalized = content;

  if (stripFileProtocol) {
    normalized = normalized.replace(/file:\/\//g, "");
  }

  if (rewriteExternalMediaUrls) {
    normalized = rewriteGithubWikiMediaUrls(normalized);
  }

  if (encodeHtmlMediaAttributes) {
    normalized = encodeHtmlUrlAttributes(normalized);
  }

  if (convertLatex) {
    normalized = convertLatexDelimiters(normalized);
  }

  return normalized;
}

function rewriteGithubWikiMediaUrls(markdown: string): string {
  return markdown.replace(
    /https:\/\/github\.com\/([^/\s)"'>]+)\/([^/\s)"'>]+)\/wiki\/([^\s)"'>]+)/gi,
    (_match, owner: string, repo: string, rest: string) =>
      `https://raw.githubusercontent.com/wiki/${owner}/${repo}/${rest}`,
  );
}

function encodeHtmlUrlAttributes(markdown: string): string {
  return markdown.replace(/<(img|a)\b[^>]*>/gi, (tag) =>
    tag.replace(
      /(src|href)\s*=\s*(["'])([^"']*)(\2)/gi,
      (_match, attr: string, quote: string, value: string, closingQuote: string) =>
        `${attr}=${quote}${encodeHtmlAttribute(value)}${closingQuote}`,
    ),
  );
}

function encodeHtmlAttribute(value: string): string {
  return value.replace(/&(?!#?[a-z0-9]+;)/gi, "&amp;");
}
