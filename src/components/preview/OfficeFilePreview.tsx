import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronLeft,
  ChevronRight,
  FileQuestion,
  Loader2,
  Maximize2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import mammoth from "mammoth";
import JSZip from "jszip";
import * as pdfjsLib from "pdfjs-dist";

import { readBase64File } from "@/lib/electron/electron-api";
import type { PreviewKind } from "@/lib/preview";
import { cn } from "@/lib/utils";

if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).toString();
}

interface OfficeFilePreviewProps {
  filePath: string;
  kind: Extract<PreviewKind, "pdf" | "docx" | "pptx">;
}

type PdfDocument = Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>;
type PdfZoomMode = "fit-width" | "custom";

interface SlidePreview {
  title: string;
  subtitle?: string;
  bullets: string[];
  imageSrc?: string;
}

interface PptxDeckPreview {
  slides: SlidePreview[];
  size: SlideSize;
}

interface SlideSize {
  width: number;
  height: number;
}

const DEFAULT_SLIDE_SIZE: SlideSize = {
  width: 12192000,
  height: 6858000,
};

export function OfficeFilePreview({ filePath, kind }: OfficeFilePreviewProps) {
  if (kind === "pdf") {
    return <PdfPreview filePath={filePath} />;
  }
  if (kind === "docx") {
    return <DocxPreview filePath={filePath} />;
  }
  return <PptxPreview filePath={filePath} />;
}

function PdfPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation("common");
  const [document, setDocument] = useState<PdfDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>("fit-width");
  const [rotation, setRotation] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef<Array<HTMLDivElement | null>>([]);
  const viewportWidth = useElementWidth(scrollRef);
  const availablePageWidth = Math.max(320, viewportWidth - 72);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;

    setLoading(true);
    setError("");
    setDocument(null);
    setPageNumber(1);

    void (async () => {
      const arrayBuffer = await readFileAsArrayBuffer(filePath);
      loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) });
      const pdf = await loadingTask.promise;
      if (!cancelled) {
        pageRefs.current = Array.from({ length: pdf.numPages }, () => null);
        setDocument(pdf);
      }
    })()
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      void loadingTask?.destroy();
    };
  }, [filePath]);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !document) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const page = Number((visible?.target as HTMLElement | undefined)?.dataset.page);
        if (Number.isFinite(page) && page > 0) {
          setPageNumber(page);
        }
      },
      {
        root,
        rootMargin: "-18% 0px -58% 0px",
        threshold: [0.1, 0.35, 0.65],
      },
    );

    pageRefs.current.forEach((node) => {
      if (node) observer.observe(node);
    });
    return () => observer.disconnect();
  }, [document, rotation, zoom, zoomMode]);

  const pages = useMemo(
    () =>
      document
        ? Array.from({ length: document.numPages }, (_, index) => index + 1)
        : [],
    [document],
  );

  const scrollToPage = useCallback((target: number) => {
    const nextPage = clamp(target, 1, pageRefs.current.length || 1);
    pageRefs.current[nextPage - 1]?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
    setPageNumber(nextPage);
  }, []);

  const changeZoom = (delta: number) => {
    setZoomMode("custom");
    setZoom((value) => clamp(Math.round((value + delta) * 10) / 10, 0.4, 2.6));
  };

  if (loading) return <PreviewLoading text={t("officePreview.openingPdf")} />;
  if (error) return <PreviewError message={error} />;
  if (!document) return <PreviewError message={t("officePreview.emptyPdf")} />;

  return (
    <div className="flex h-full flex-col bg-[#dfe0dc] text-[#202421]">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[#c8cbc5] bg-[#f7f7f4] px-3 shadow-sm">
        <ReaderButton
          label={t("officePreview.previousPage")}
          disabled={pageNumber <= 1}
          onClick={() => scrollToPage(pageNumber - 1)}
        >
          <ChevronLeft className="size-4" />
        </ReaderButton>
        <ReaderButton
          label={t("officePreview.nextPage")}
          disabled={pageNumber >= document.numPages}
          onClick={() => scrollToPage(pageNumber + 1)}
        >
          <ChevronRight className="size-4" />
        </ReaderButton>

        <div className="ml-1 flex h-7 items-center rounded-md border border-[#d8dad4] bg-white px-2 text-xs tabular-nums text-[#4c544e]">
          <span className="min-w-5 text-center">{pageNumber}</span>
          <span className="mx-1 text-[#899089]">/</span>
          <span>{document.numPages}</span>
        </div>

        <div className="mx-2 h-5 w-px bg-[#d3d5d0]" />

        <ReaderButton label={t("officePreview.zoomOut")} onClick={() => changeZoom(-0.1)}>
          <ZoomOut className="size-4" />
        </ReaderButton>
        <button
          type="button"
          onClick={() => setZoomMode("fit-width")}
          className={cn(
            "h-7 rounded-md px-2 text-xs font-medium transition-colors",
            zoomMode === "fit-width"
              ? "bg-[#202421] text-white"
              : "text-[#4c544e] hover:bg-[#e9ebe6]",
          )}
          title={t("officePreview.fitWidth")}
        >
          {zoomMode === "fit-width" ? t("officePreview.fitWidth") : `${Math.round(zoom * 100)}%`}
        </button>
        <ReaderButton label={t("officePreview.zoomIn")} onClick={() => changeZoom(0.1)}>
          <ZoomIn className="size-4" />
        </ReaderButton>
        <ReaderButton
          label={t("officePreview.rotate")}
          onClick={() => setRotation((value) => (value + 90) % 360)}
        >
          <RotateCw className="size-4" />
        </ReaderButton>

        <div className="ml-auto flex items-center gap-1 text-xs text-[#69716b]">
          <Maximize2 className="size-3.5" />
          <span>{t("officePreview.continuousPages")}</span>
        </div>
      </div>

      <div ref={scrollRef} className="app-scrollbar min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full flex-col gap-5 px-5 py-6">
          {pages.map((page) => (
            <div
              key={page}
              ref={(node) => {
                pageRefs.current[page - 1] = node;
              }}
              data-page={page}
              className="flex justify-center gap-3"
            >
              <div className="hidden w-10 shrink-0 pt-2 text-right text-xs tabular-nums text-[#747b75] sm:block">
                {page}
              </div>
              <PdfPageCanvas
                document={document}
                pageNumber={page}
                availableWidth={availablePageWidth}
                zoom={zoom}
                zoomMode={zoomMode}
                rotation={rotation}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PdfPageCanvas({
  document,
  pageNumber,
  availableWidth,
  zoom,
  zoomMode,
  rotation,
}: {
  document: PdfDocument;
  pageNumber: number;
  availableWidth: number;
  zoom: number;
  zoomMode: PdfZoomMode;
  rotation: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendering, setRendering] = useState(true);
  const [error, setError] = useState("");
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void; promise: Promise<unknown> } | null = null;

    setRendering(true);
    setError("");

    void (async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled) return;

      const baseViewport = page.getViewport({ scale: 1, rotation });
      const scale =
        zoomMode === "fit-width"
          ? clamp(availableWidth / baseViewport.width, 0.3, 2.8)
          : zoom;
      const viewport = page.getViewport({ scale, rotation });
      const canvas = canvasRef.current;
      const context = canvas?.getContext("2d");
      if (!canvas || !context) {
        throw new Error("Unable to create PDF canvas.");
      }

      const outputScale = clamp(window.devicePixelRatio || 1, 1, 2);
      canvas.width = Math.floor(viewport.width * outputScale);
      canvas.height = Math.floor(viewport.height * outputScale);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setPageSize({ width: viewport.width, height: viewport.height });

      renderTask = page.render({
        canvas,
        canvasContext: context,
        viewport,
        transform:
          outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
      });
      await renderTask.promise;
      page.cleanup();
    })()
      .catch((err: unknown) => {
        if (cancelled || isPdfRenderCancelled(err)) return;
        setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setRendering(false);
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableWidth, document, pageNumber, rotation, zoom, zoomMode]);

  if (error) {
    return (
      <div
        className="flex min-h-[320px] w-full max-w-[720px] items-center justify-center rounded-sm bg-white px-6 text-center text-xs text-muted-foreground shadow-[0_10px_32px_rgba(28,31,28,0.18)]"
        style={pageSize ? { width: pageSize.width } : undefined}
      >
        第 {pageNumber} 页渲染失败：{error}
      </div>
    );
  }

  return (
    <div
      className="relative overflow-hidden rounded-sm bg-white shadow-[0_10px_32px_rgba(28,31,28,0.20)]"
      style={pageSize ? { width: pageSize.width, minHeight: pageSize.height } : undefined}
    >
      {rendering ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-white/70 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          渲染中
        </div>
      ) : null}
      <canvas ref={canvasRef} className="block bg-white" />
    </div>
  );
}

function DocxPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation("common");
  const [html, setHtml] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setHtml("");

    void (async () => {
      const arrayBuffer = await readFileAsArrayBuffer(filePath);
      const result = await mammoth.convertToHtml(
        { arrayBuffer },
        {
          styleMap: [
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
          ],
        },
      );
      if (!cancelled) setHtml(result.value);
    })()
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  if (loading) return <PreviewLoading text={t("officePreview.parsingWord")} />;
  if (error) return <PreviewError message={error} />;

  return (
    <div className="app-scrollbar h-full overflow-auto bg-[#ecece8] px-4 py-6">
      <article
        className="mx-auto min-h-[980px] w-full max-w-[794px] bg-white px-6 py-8 text-[15px] leading-7 text-[#202421] shadow-[0_18px_52px_rgba(30,32,30,0.16)] sm:px-14 sm:py-12 [&_a]:text-[#315f8c] [&_h1]:mb-6 [&_h1]:mt-0 [&_h1]:text-3xl [&_h1]:font-semibold [&_h1]:leading-tight [&_h2]:mb-4 [&_h2]:mt-8 [&_h2]:text-2xl [&_h2]:font-semibold [&_h2]:leading-tight [&_h3]:mb-3 [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_img]:my-4 [&_img]:max-w-full [&_li]:my-1.5 [&_ol]:my-4 [&_ol]:pl-6 [&_p]:my-3 [&_table]:my-5 [&_table]:w-full [&_table]:border-collapse [&_td]:border [&_td]:border-[#d6d8d4] [&_td]:p-2 [&_th]:border [&_th]:border-[#c8cbc5] [&_th]:bg-[#f3f4f1] [&_th]:p-2 [&_ul]:my-4 [&_ul]:pl-6"
        dangerouslySetInnerHTML={{ __html: html || `<p>${t("officePreview.blankDocument")}</p>` }}
      />
    </div>
  );
}

function PptxPreview({ filePath }: { filePath: string }) {
  const { t } = useTranslation("common");
  const [deck, setDeck] = useState<PptxDeckPreview>({
    slides: [],
    size: DEFAULT_SLIDE_SIZE,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setDeck({ slides: [], size: DEFAULT_SLIDE_SIZE });

    void parsePptxDeck(filePath)
      .then((items) => {
        if (!cancelled) setDeck(items);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const slides =
    deck.slides.length > 0 ? deck.slides : [{ title: t("officePreview.blankPresentation"), bullets: [] }];
  const ratioLabel = formatSlideRatio(deck.size);

  if (loading) return <PreviewLoading text={t("officePreview.parsingPpt")} />;
  if (error) return <PreviewError message={error} />;

  return (
    <div className="flex h-full flex-col bg-[#ecece8] text-[#202421]">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-[#d7d9d3] bg-[#f7f7f4] px-4 text-xs text-[#69716b]">
        <span className="font-medium text-[#202421]">{t("officePreview.slidePreview")}</span>
        <span className="tabular-nums">
          {t("officePreview.pageCount", { count: slides.length })} · {ratioLabel}
        </span>
      </div>
      <div className="app-scrollbar min-h-0 flex-1 overflow-auto p-4">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
          {slides.map((slide, index) => (
            <div key={`${slide.title}-${index}`} className="flex gap-3">
              <div className="hidden w-10 shrink-0 pt-2 text-right text-xs tabular-nums text-[#747b75] sm:block">
                {String(index + 1).padStart(2, "0")}
              </div>
              <section
                className="w-full overflow-hidden rounded-md border border-[#d9dcd6] bg-white text-[#202421] shadow-[0_14px_42px_rgba(30,32,30,0.14)]"
                style={{
                  aspectRatio: `${deck.size.width} / ${deck.size.height}`,
                }}
              >
                {slide.imageSrc ? (
                  <img
                    src={slide.imageSrc}
                    alt={slide.title}
                    className="size-full bg-white object-contain"
                  />
                ) : (
                  <div className="flex h-full flex-col p-7">
                    <div className="text-xs font-medium tabular-nums text-[#607d73]">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <h3 className="mt-3 text-2xl font-semibold leading-tight">
                      {slide.title}
                    </h3>
                    {slide.subtitle ? (
                      <p className="mt-2 text-sm leading-6 text-[#5f6861]">
                        {slide.subtitle}
                      </p>
                    ) : null}
                    <div className="mt-5 space-y-2.5">
                      {slide.bullets.map((bullet) => (
                        <p
                          key={bullet}
                          className="pl-5 text-sm leading-6 before:mr-2 before:content-['•']"
                        >
                          {bullet}
                        </p>
                      ))}
                    </div>
                  </div>
                )}
              </section>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ReaderButton({
  children,
  disabled,
  label,
  onClick,
}: {
  children: React.ReactNode;
  disabled?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      className="flex size-7 items-center justify-center rounded-md text-[#4c544e] transition-colors hover:bg-[#e9ebe6] hover:text-[#202421] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

function PreviewLoading({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {text}
    </div>
  );
}

function PreviewError({ message }: { message: string }) {
  const { t } = useTranslation("common");
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-2 text-center text-muted-foreground">
        <FileQuestion className="size-10 opacity-60" />
	        <p className="text-sm font-medium text-foreground">{t("officePreview.cannotPreview")}</p>
        <p className="text-xs leading-5">{message}</p>
      </div>
    </div>
  );
}

function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => setWidth(element.clientWidth);
    update();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", update);
      return () => window.removeEventListener("resize", update);
    }

    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

async function readFileAsArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  return base64ToArrayBuffer(await readBase64File(filePath));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

async function parsePptxDeck(filePath: string): Promise<PptxDeckPreview> {
  const zip = await JSZip.loadAsync(await readFileAsArrayBuffer(filePath));
  const size = await readPresentationSize(zip);
  const slideNames = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const slides = await Promise.all(
    slideNames.map(async (name, index) => {
      const file = zip.file(name);
      const xml = file ? await file.async("string") : "";
      const imageSrc = await slideImageDataUrl(zip, name);
      const texts = extractSlideTexts(xml);
      const [title, ...rest] = texts;
      const subtitle = rest.length > 3 ? rest.shift() : undefined;
      return {
        title: title || `第 ${index + 1} 页`,
        subtitle,
        bullets: rest.filter(Boolean),
        imageSrc,
      };
    }),
  );

  return { slides, size };
}

async function readPresentationSize(zip: JSZip): Promise<SlideSize> {
  const xml = await zip.file("ppt/presentation.xml")?.async("string");
  if (!xml?.trim()) return DEFAULT_SLIDE_SIZE;

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const slideSize =
    doc.getElementsByTagName("p:sldSz")[0] ||
    doc.getElementsByTagNameNS(
      "http://schemas.openxmlformats.org/presentationml/2006/main",
      "sldSz",
    )[0];
  const width = Number(slideSize?.getAttribute("cx"));
  const height = Number(slideSize?.getAttribute("cy"));

  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return { width, height };
  }
  return DEFAULT_SLIDE_SIZE;
}

async function slideImageDataUrl(zip: JSZip, slideName: string): Promise<string | undefined> {
  const relsName = slideName.replace("ppt/slides/", "ppt/slides/_rels/") + ".rels";
  const rels = await zip.file(relsName)?.async("string");
  if (!rels) return undefined;

  const imageTarget =
    /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"[^>]*Target="([^"]+)"/i.exec(
      rels,
    )?.[1] ||
    /Target="([^"]+)"[^>]*Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"/i.exec(
      rels,
    )?.[1];
  if (!imageTarget) return undefined;

  const imagePath = normalizeZipPath("ppt/slides", imageTarget);
  const imageFile = zip.file(imagePath);
  if (!imageFile) return undefined;

  const base64 = await imageFile.async("base64");
  const ext = imagePath.split(".").pop()?.toLowerCase() || "png";
  const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`;
  return `data:${mime};base64,${base64}`;
}

function normalizeZipPath(baseDir: string, target: string): string {
  const baseParts = baseDir.split("/");
  const parts = target.startsWith("/")
    ? target.split("/")
    : [...baseParts, ...target.split("/")];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") normalized.pop();
    else normalized.push(part);
  }
  return normalized.join("/");
}

function slideNumber(name: string): number {
  return Number(/slide(\d+)\.xml$/i.exec(name)?.[1] ?? 0);
}

function extractSlideTexts(xml: string): string[] {
  if (!xml.trim()) return [];
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const nodes = doc.getElementsByTagNameNS(
    "http://schemas.openxmlformats.org/drawingml/2006/main",
    "t",
  );
  const fallback = nodes.length > 0 ? nodes : doc.getElementsByTagName("a:t");
  return Array.from(fallback)
    .map((node) => node.textContent?.trim() ?? "")
    .filter(Boolean);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatSlideRatio(size: SlideSize): string {
  const ratio = size.width / size.height;
  if (Math.abs(ratio - 16 / 9) < 0.02) return "16:9";
  if (Math.abs(ratio - 4 / 3) < 0.02) return "4:3";

  const divisor = greatestCommonDivisor(
    Math.round(size.width),
    Math.round(size.height),
  );
  return `${Math.round(size.width / divisor)}:${Math.round(size.height / divisor)}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let left = Math.abs(a);
  let right = Math.abs(b);
  while (right > 0) {
    const next = left % right;
    left = right;
    right = next;
  }
  return left || 1;
}

function isPdfRenderCancelled(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "RenderingCancelledException" ||
      error.message.includes("cancelled"))
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
