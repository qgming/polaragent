import { code as streamdownCode } from "@streamdown/code";
import { mermaid as streamdownMermaid } from "@streamdown/mermaid";
import {
  useCallback,
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from "react";
import { Streamdown } from "streamdown";

import {
  downloadUrlAsBase64,
  fileUrl,
  isElectronRuntime,
} from "@/lib/electron/electron-api";
import {
  markdownSanitizeSchema,
  normalizeMarkdownContent,
  rehypeKatex,
  rehypeRaw,
  rehypeSanitize,
  remarkBreaks,
  remarkGfm,
  remarkMath,
} from "@/lib/markdown";
import { cn } from "@/lib/utils";

interface MarkdownPreviewProps {
  content: string;
  filePath?: string;
  className?: string;
}

type StreamdownRemarkPlugins = NonNullable<
  ComponentProps<typeof Streamdown>["remarkPlugins"]
>;

type StreamdownRehypePlugins = NonNullable<
  ComponentProps<typeof Streamdown>["rehypePlugins"]
>;

interface MarkdownPreviewImageProps
  extends ImgHTMLAttributes<HTMLImageElement> {
  baseDir?: string;
}

function isDataOrRemoteUrl(value?: string): boolean {
  if (!value) return false;
  return /^(https?:|data:|blob:|file:)/i.test(value);
}

function isAbsoluteLocalPath(value?: string): boolean {
  if (!value) return false;
  return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(value);
}

function dirname(path?: string): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? undefined : normalized.slice(0, index);
}

function joinPath(base: string, child: string): string {
  const normalizedBase = base.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedChild = child.replace(/\\/g, "/").replace(/^\.?\//, "");
  return `${normalizedBase}/${normalizedChild}`;
}

function contentTypeToDataUrl(contentType: string, base64: string): string {
  return `data:${contentType || "application/octet-stream"};base64,${base64}`;
}

function useImageResolverCache() {
  const cacheRef = useRef(new Map<string, string>());
  const inflightRef = useRef(new Map<string, Promise<string>>());

  return useCallback((key: string, load: () => Promise<string>) => {
    const cached = cacheRef.current.get(key);
    if (cached) return Promise.resolve(cached);

    const inflight = inflightRef.current.get(key);
    if (inflight) return inflight;

    const promise = load()
      .then((result) => {
        cacheRef.current.set(key, result);
        return result;
      })
      .finally(() => {
        inflightRef.current.delete(key);
      });

    inflightRef.current.set(key, promise);
    return promise;
  }, []);
}

function MarkdownPreviewImage({
  src,
  alt,
  baseDir,
  ...props
}: MarkdownPreviewImageProps) {
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(undefined);
  const resolveImage = useImageResolverCache();

  useEffect(() => {
    let cancelled = false;

    async function resolve() {
      if (!src) {
        setResolvedSrc(undefined);
        return;
      }

      if (/^https?:/i.test(src) && isElectronRuntime()) {
        try {
          const result = await resolveImage(src, async () => {
            const downloaded = await downloadUrlAsBase64({
              url: src,
              timeoutMs: 15000,
            });
            return contentTypeToDataUrl(downloaded.contentType, downloaded.base64);
          });
          if (!cancelled) setResolvedSrc(result);
          return;
        } catch {
          if (!cancelled) setResolvedSrc(src);
          return;
        }
      }

      if (isDataOrRemoteUrl(src)) {
        setResolvedSrc(src);
        return;
      }

      if (!isElectronRuntime()) {
        setResolvedSrc(src);
        return;
      }

      const decoded = decodeURIComponent(src);
      const absolutePath = isAbsoluteLocalPath(decoded)
        ? decoded
        : baseDir
          ? joinPath(baseDir, decoded)
          : decoded;

      try {
        const url = await resolveImage(absolutePath, () => fileUrl(absolutePath));
        if (!cancelled) setResolvedSrc(url);
      } catch {
        if (!cancelled) setResolvedSrc(undefined);
      }
    }

    void resolve();
    return () => {
      cancelled = true;
    };
  }, [src, baseDir, resolveImage]);

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
      crossOrigin="anonymous"
      className="max-w-full rounded-md"
    />
  );
}

export function MarkdownPreview({
  content,
  filePath,
  className,
}: MarkdownPreviewProps) {
  const baseDir = useMemo(() => dirname(filePath), [filePath]);
  const previewSource = useMemo(
    () =>
      normalizeMarkdownContent(content, {
        convertLatex: true,
        stripFileProtocol: true,
        rewriteExternalMediaUrls: true,
        encodeHtmlMediaAttributes: true,
      }),
    [content],
  );
  const mermaidTheme = document.documentElement.classList.contains("dark")
    ? "dark"
    : "default";
  const remarkPlugins = useMemo<StreamdownRemarkPlugins>(
    () => [remarkGfm, remarkMath, remarkBreaks],
    [],
  );
  const rehypePlugins = useMemo<StreamdownRehypePlugins>(
    () => [rehypeRaw, [rehypeSanitize, markdownSanitizeSchema], rehypeKatex],
    [],
  );

  return (
    <div
      className={cn(
        "markdown-preview prose max-w-none break-words text-foreground dark:prose-invert",
        className,
      )}
    >
      <Streamdown
        mode="static"
        controls={{ table: false, mermaid: false }}
        mermaid={{ config: { theme: mermaidTheme } }}
        plugins={{ code: streamdownCode, mermaid: streamdownMermaid }}
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{
          img({ src, alt, ...props }) {
            return (
              <MarkdownPreviewImage
                {...props}
                src={typeof src === "string" ? src : undefined}
                alt={typeof alt === "string" ? alt : undefined}
                baseDir={baseDir}
              />
            );
          },
        }}
      >
        {previewSource}
      </Streamdown>
    </div>
  );
}
