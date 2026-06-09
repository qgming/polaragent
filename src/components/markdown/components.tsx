import {
  useEffect,
  useMemo,
  useState,
  type ImgHTMLAttributes,
  type MouseEvent,
} from "react";
import type { Components } from "react-markdown";

import { CodeBlock } from "@/components/markdown/CodeBlock";
import { MathBlock } from "@/components/markdown/MathBlock";
import { MermaidDiagram } from "@/components/markdown/MermaidDiagram";
import { fileUrl, isElectronRuntime, openExternal } from "@/lib/electron/electron-api";
import { isClosedFencedCodeBlock } from "@/lib/markdown";

interface CreateMarkdownComponentsOptions {
  streaming: boolean;
  sourceContent: string;
  sourceBasePath?: string;
}

function isHttpUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function isRemoteOrDataUrl(src: string): boolean {
  return /^(https?:|data:|blob:|file:)/i.test(src);
}

function isAbsolutePath(path: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path);
}

function joinPath(base: string, child: string): string {
  if (!base) return child;
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedChild = child.replace(/\\/g, "/").replace(/^\.?\//, "");
  return `${normalizedBase}/${normalizedChild}`;
}

function resolveLocalPath(src: string, sourceBasePath?: string): string {
  const decoded = decodeURIComponent(src);
  if (isAbsolutePath(decoded) || !sourceBasePath) return decoded;
  return joinPath(sourceBasePath, decoded);
}

function MarkdownImage({
  src,
  alt,
  sourceBasePath,
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { sourceBasePath?: string }) {
  const [resolvedSrc, setResolvedSrc] = useState(src);

  useEffect(() => {
    let cancelled = false;
    if (!src || isRemoteOrDataUrl(src) || !isElectronRuntime()) {
      setResolvedSrc(src);
      return;
    }

    void fileUrl(resolveLocalPath(src, sourceBasePath))
      .then((url) => {
        if (!cancelled) setResolvedSrc(url);
      })
      .catch(() => {
        if (!cancelled) setResolvedSrc("");
      });

    return () => {
      cancelled = true;
    };
  }, [src, sourceBasePath]);

  if (!resolvedSrc) {
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  }

  return (
    <img
      {...props}
      src={resolvedSrc}
      alt={alt ?? ""}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="max-w-full rounded-md"
    />
  );
}

export function createMarkdownComponents({
  streaming,
  sourceContent,
  sourceBasePath,
}: CreateMarkdownComponentsOptions): Components {
  return {
    pre({ children }) {
      return <>{children}</>;
    },
    code({ className, children, ...rest }) {
      const match = /language-([\w-]+)/.exec(className || "");
      const isBlock = Boolean(className);
      const code = String(children).replace(/\n$/, "");
      const language = (match ? match[1] : "text").toLowerCase();

      if (isBlock && code) {
        if (language === "mermaid") {
          const shouldRenderDiagram =
            !streaming || isClosedFencedCodeBlock(sourceContent, language, code);
          return shouldRenderDiagram ? (
            <MermaidDiagram code={code} />
          ) : (
            <CodeBlock code={code} language={language} />
          );
        }

        if (language === "math" || language === "tex" || language === "latex") {
          return <MathBlock code={code} />;
        }

        return <CodeBlock code={code} language={language} />;
      }

      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
          {...rest}
        >
          {children}
        </code>
      );
    },
    a: ({ children, href }) => {
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!href || !isElectronRuntime() || !isHttpUrl(href)) return;
        event.preventDefault();
        void openExternal(href);
      };

      return (
        <a
          href={href}
          onClick={handleClick}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent-foreground underline-offset-2 hover:underline"
        >
          {children}
        </a>
      );
    },
    table: ({ children }) => (
      <div className="markdown-table-wrap app-scrollbar my-3 overflow-x-auto">
        <table>{children}</table>
      </div>
    ),
    img: ({ src, alt, ...props }) => (
      <MarkdownImage
        {...props}
        src={src}
        alt={alt}
        sourceBasePath={sourceBasePath}
      />
    ),
  };
}

export function useMarkdownComponents(options: CreateMarkdownComponentsOptions) {
  return useMemo(
    () => createMarkdownComponents(options),
    [options.streaming, options.sourceContent, options.sourceBasePath],
  );
}
