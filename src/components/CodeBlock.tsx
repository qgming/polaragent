// 代码块组件（带语法高亮、搜索命中高亮和复制按钮）
// src/components/CodeBlock.tsx

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import hljs from "highlight.js/lib/common";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  searchQuery?: string;
}

const LANGUAGE_ALIASES: Record<string, string> = {
  cjs: "javascript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  ps1: "powershell",
  pwsh: "powershell",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  tsx: "typescript",
  yml: "yaml",
};

const PLAIN_LANGUAGES = new Set(["", "plain", "plaintext", "text", "txt"]);

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLanguage(language: string) {
  const normalized = language.trim().toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function highlightCode(code: string, language: string) {
  const normalizedLanguage = normalizeLanguage(language);

  if (PLAIN_LANGUAGES.has(normalizedLanguage)) {
    return {
      html: escapeHtml(code),
      language: "text",
      highlighted: false,
    };
  }

  if (hljs.getLanguage(normalizedLanguage)) {
    const result = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true,
    });
    return {
      html: result.value,
      language: result.language ?? normalizedLanguage,
      highlighted: true,
    };
  }

  const result = hljs.highlightAuto(code);
  return {
    html: result.value,
    language: result.language ?? (language || "text"),
    highlighted: Boolean(result.language),
  };
}

function addSearchMarks(html: string, query: string) {
  const trimmed = query.trim();
  if (!trimmed) {
    return html;
  }

  const pattern = new RegExp(escapeRegExp(escapeHtml(trimmed)), "gi");
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) {
        return part;
      }
      return part.replace(
        pattern,
        '<mark class="code-search-mark">$&</mark>',
      );
    })
    .join("");
}

export function CodeBlock({
  code,
  language = "text",
  searchQuery = "",
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const highlighted = useMemo(() => {
    const result = highlightCode(code, language);
    return {
      ...result,
      html: addSearchMarks(result.html, searchQuery),
    };
  }, [code, language, searchQuery]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      return;
    }
    const mark = containerRef.current?.querySelector(".code-search-mark");
    mark?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [searchQuery, highlighted.html]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      ref={containerRef}
      className="code-block not-prose group relative my-4 overflow-hidden rounded-lg border border-white/10 bg-[#1e1e1e] text-[1em] shadow-sm"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 bg-black/10 px-3 py-1">
        <span
          className={cn(
            "text-xs",
            highlighted.highlighted ? "text-gray-300" : "text-gray-500",
          )}
        >
          {highlighted.language}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCopy}
          className="h-7 gap-2 px-2 text-xs text-gray-400 opacity-0 transition-opacity hover:text-white group-hover:opacity-100"
        >
          {copied ? (
            <>
              <Check className="size-3" />
              已复制
            </>
          ) : (
            <>
              <Copy className="size-3" />
              复制代码
            </>
          )}
        </Button>
      </div>

      {/* Code */}
      <pre className="app-scrollbar overflow-x-auto px-3 py-2">
        <code
          className="hljs block text-[1.05em] text-gray-100"
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  );
}
