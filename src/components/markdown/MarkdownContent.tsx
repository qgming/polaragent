// 统一 Markdown 渲染入口：会话页与预览窗口共用

import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { createMarkdownComponents } from "@/lib/markdown-components";
import { cn } from "@/lib/utils";

interface MarkdownContentProps {
  content: string;
  streaming?: boolean;
  className?: string;
}

export function MarkdownContent({
  content,
  streaming = false,
  className,
}: MarkdownContentProps) {
  const components = useMemo(
    () => createMarkdownComponents(streaming),
    [streaming],
  );

  return (
    <div
      className={cn(
        "chat-content prose prose-sm max-w-none break-words leading-7 text-foreground dark:prose-invert",
        className,
      )}
    >
      {content ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      ) : (
        " "
      )}
    </div>
  );
}
