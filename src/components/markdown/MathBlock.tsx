import { useMemo } from "react";
import katex from "katex";

import { CodeBlock } from "@/components/markdown/CodeBlock";

interface MathBlockProps {
  code: string;
}

function isFullLatexDocument(source: string): boolean {
  return /\\(documentclass|usepackage)\b|\\begin\{document\}/.test(source);
}

export function MathBlock({ code }: MathBlockProps) {
  const html = useMemo(() => {
    const source = code.trim();
    if (!source || isFullLatexDocument(source)) return null;

    try {
      return katex.renderToString(source, {
        displayMode: true,
        throwOnError: false,
      });
    } catch {
      return null;
    }
  }, [code]);

  if (!html) {
    return <CodeBlock code={code} language="latex" />;
  }

  return (
    <div className="math-block not-prose my-4 max-w-full overflow-x-auto overflow-y-hidden py-1">
      <div
        className="katex-display"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
