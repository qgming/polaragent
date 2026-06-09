import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide-react";
import hljs from "highlight.js/lib/common";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language?: string;
  searchQuery?: string;
}

const COLLAPSE_THRESHOLD_LINES = 40;
const COLLAPSED_VISIBLE_LINES = 20;

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
  if (!trimmed) return html;

  const pattern = new RegExp(escapeRegExp(escapeHtml(trimmed)), "gi");
  return html
    .split(/(<[^>]+>)/g)
    .map((part) => {
      if (part.startsWith("<")) return part;
      return part.replace(pattern, '<mark class="code-search-mark">$&</mark>');
    })
    .join("");
}

function visibleCode(code: string, expanded: boolean) {
  const lines = code.split("\n");
  if (expanded || lines.length <= COLLAPSE_THRESHOLD_LINES) {
    return code;
  }
  return lines.slice(0, COLLAPSED_VISIBLE_LINES).join("\n");
}

export function CodeBlock({
  code,
  language = "text",
  searchQuery = "",
}: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const totalLines = useMemo(() => code.split("\n").length, [code]);
  const canCollapse = totalLines > COLLAPSE_THRESHOLD_LINES;
  const renderedCode = useMemo(() => visibleCode(code, expanded), [code, expanded]);
  const highlighted = useMemo(() => {
    const result = highlightCode(renderedCode, language);
    return {
      ...result,
      html: addSearchMarks(result.html, searchQuery),
    };
  }, [renderedCode, language, searchQuery]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    const mark = containerRef.current?.querySelector(".code-search-mark");
    mark?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [searchQuery, highlighted.html]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleExpanded = () => {
    const willCollapse = expanded;
    setExpanded((value) => !value);
    if (willCollapse) {
      requestAnimationFrame(() => {
        containerRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
      });
    }
  };

  return (
    <div
      ref={containerRef}
      className="code-block not-prose group relative my-4 overflow-hidden rounded-lg border border-white/10 bg-[#1e1e1e] text-[1em] shadow-sm"
    >
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-black/10 px-3 py-1">
        <span
          className={cn(
            "min-w-0 truncate text-xs",
            highlighted.highlighted ? "text-gray-300" : "text-gray-500",
          )}
          title={highlighted.language}
        >
          {highlighted.language}
        </span>
        <div className="flex shrink-0 items-center gap-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100">
          {canCollapse ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleExpanded}
              className="h-7 gap-1 px-2 text-xs text-gray-400 hover:text-white"
            >
              {expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {expanded ? "收起" : "展开"}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCopy}
            className="h-7 gap-2 px-2 text-xs text-gray-400 hover:text-white"
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
      </div>

      <pre className="app-scrollbar overflow-x-auto px-3 py-1.5">
        <code
          className="hljs block font-mono text-[0.92em] leading-[1.45] text-gray-100"
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>

      {canCollapse ? (
        <button
          type="button"
          onClick={toggleExpanded}
          className="code-block-footer flex w-full items-center justify-center gap-1 border-t border-white/10 bg-black/10 px-3 py-2 text-xs text-gray-400 transition-colors hover:text-white"
        >
          {expanded ? (
            <>
              <ChevronUp className="size-3.5" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="size-3.5" />
              展开 {totalLines - COLLAPSED_VISIBLE_LINES} 行
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}
