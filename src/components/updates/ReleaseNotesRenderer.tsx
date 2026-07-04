import DOMPurify from "dompurify";
import { useMemo } from "react";

import { MarkdownContent } from "@/components/markdown/MarkdownContent";

interface ReleaseNotesRendererProps {
  content: string;
  className?: string;
}

/**
 * 智能渲染 GitHub Release Notes
 * 自动检测 HTML 或 Markdown 格式并使用合适的渲染方式
 */
export function ReleaseNotesRenderer({ content, className = "" }: ReleaseNotesRendererProps) {
  // 检测内容格式：HTML 或 Markdown
  const format = useMemo(() => {
    if (!content) return null;
    // 检测 HTML 标签
    const htmlTagPattern = /<(h[1-6]|p|div|ul|ol|li|strong|em|a|br|hr|blockquote|pre|code)\b[^>]*>/i;
    return htmlTagPattern.test(content) ? "html" : "markdown";
  }, [content]);

  // HTML 格式：使用 DOMPurify 清理
  const sanitizedHtml = useMemo(() => {
    if (format === "html") {
      return DOMPurify.sanitize(content, {
        ALLOWED_TAGS: [
          "h1",
          "h2",
          "h3",
          "h4",
          "h5",
          "h6",
          "p",
          "div",
          "span",
          "br",
          "hr",
          "ul",
          "ol",
          "li",
          "strong",
          "b",
          "em",
          "i",
          "u",
          "s",
          "del",
          "a",
          "code",
          "pre",
          "blockquote",
          "table",
          "thead",
          "tbody",
          "tr",
          "th",
          "td",
        ],
        ALLOWED_ATTR: ["href", "target", "rel", "class"],
        // 自动为外部链接添加安全属性
        RETURN_DOM_FRAGMENT: false,
        RETURN_DOM: false,
      });
    }
    return null;
  }, [format, content]);

  if (!content) {
    return null;
  }

  if (format === "html") {
    return (
      <div
        className={`markdown-preview prose prose-sm max-w-none break-words text-foreground dark:prose-invert prose-headings:mt-3 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-1 ${className}`}
        dangerouslySetInnerHTML={{ __html: sanitizedHtml || "" }}
      />
    );
  }

  // Markdown 格式
  return (
    <MarkdownContent
      content={content}
      variant="compact"
      className={`prose-headings:mt-3 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 ${className}`}
    />
  );
}
