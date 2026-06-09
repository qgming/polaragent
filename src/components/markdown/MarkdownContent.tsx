import { useMemo } from "react";
import ReactMarkdown from "react-markdown";

import { useMarkdownComponents } from "@/components/markdown/components";
import {
  markdownHtmlRehypePlugins,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  normalizeMarkdownContent,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  streaming?: boolean;
  className?: string;
  allowHtml?: boolean;
  sourceBasePath?: string;
  variant?: "chat" | "compact";
}

export function MarkdownContent({
  content,
  streaming = false,
  className,
  allowHtml = false,
  sourceBasePath,
  variant = "chat",
}: MarkdownContentProps) {
  const normalizedContent = useMemo(
    () =>
      normalizeMarkdownContent(content, {
        convertLatex: true,
        stripFileProtocol: false,
      }),
    [content],
  );
  const components = useMarkdownComponents({
    streaming,
    sourceContent: normalizedContent,
    sourceBasePath,
  });

  return (
    <div
      className={cn(
        "chat-content prose max-w-none break-words text-foreground dark:prose-invert",
        variant === "chat" && "prose-sm leading-7",
        variant === "compact" && "prose-sm leading-6",
        className,
      )}
    >
      {normalizedContent ? (
        <ReactMarkdown
          remarkPlugins={markdownRemarkPlugins}
          rehypePlugins={allowHtml ? markdownHtmlRehypePlugins : markdownRehypePlugins}
          components={components}
        >
          {normalizedContent}
        </ReactMarkdown>
      ) : (
        " "
      )}
    </div>
  );
}
