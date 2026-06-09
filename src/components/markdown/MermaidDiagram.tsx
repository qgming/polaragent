// Mermaid 图表渲染组件
//
// 把 ```mermaid 代码块渲染成 SVG 图。支持：
//   - 明暗主题自适应（跟随 documentElement 的 .dark 类）
//   - 渲染失败（语法错误/源码不完整）时回退为原始代码块
//   - 工具条：复制源码 / 下载 SVG / 下载 PNG / 点击放大查看

import { useEffect, useId, useMemo, useRef, useState } from "react";
import mermaid from "mermaid";
import { Check, Copy, Download, Maximize2, FileImage } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { CodeBlock } from "@/components/markdown/CodeBlock";

// 全局只初始化一次主题外的基础配置
let initialized = false;
function ensureInit() {
  if (initialized) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict", // 禁止图表内嵌脚本/点击回调，防注入
    suppressErrorRendering: true, // 失败时不向 DOM 注入红色错误块，由我们自行回退
  });
  initialized = true;
}

// 当前是否暗色主题（与 App.tsx 的 .dark 类一致）
function isDarkTheme(): boolean {
  return document.documentElement.classList.contains("dark");
}

const MIN_SCALE_WIDTH = 58;
const MAX_SCALE_WIDTH = 100;

function scaleWidthForRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 86;
  const normalized = ratio >= 1 ? ratio : 1 / ratio;
  const distance = Math.max(0, normalized - 1);
  const scale = MAX_SCALE_WIDTH - distance * 18;
  return Math.max(MIN_SCALE_WIDTH, Math.min(MAX_SCALE_WIDTH, Math.round(scale)));
}

function getSvgRatio(el: SVGElement): number {
  const viewBox = el.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    const [, , width, height] = parts;
    if (width > 0 && height > 0) return width / height;
  }

  const width = Number.parseFloat(el.getAttribute("width") || "");
  const height = Number.parseFloat(el.getAttribute("height") || "");
  if (width > 0 && height > 0) return width / height;

  return 0;
}

function cleanSvgStyle(style: string): string {
  return style
    .replace(/max-width:[^;]+;?/g, "")
    .replace(/width:[^;]+;?/g, "")
    .replace(/height:[^;]+;?/g, "")
    .replace(/display:[^;]+;?/g, "")
    .replace(/margin:[^;]+;?/g, "");
}

// 后处理 mermaid SVG：根据宽高比智能缩放。越接近正方形越接近 100%，
// 越扁或越高则适当收小，避免在聊天流里过度占屏。
function fitSvgWidth(svg: string, fullBleed = false): string {
  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const el = doc.querySelector("svg");
    if (!el) return svg;

    const ratio = getSvgRatio(el);
    const widthPercent = fullBleed ? 100 : scaleWidthForRatio(ratio);
    const cleanedStyle = cleanSvgStyle(el.getAttribute("style") || "");

    el.removeAttribute("width");
    el.removeAttribute("height");

    el.setAttribute(
      "style",
      `${cleanedStyle};width:${widthPercent}%;max-width:100%;height:auto;display:block;margin:0 auto;`.trim(),
    );

    return el.outerHTML;
  } catch {
    return svg;
  }
}

interface MermaidDiagramProps {
  code: string;
}

export function MermaidDiagram({ code }: MermaidDiagramProps) {
  // useId 提供稳定且唯一的渲染 id（mermaid.render 要求 DOM id 合法，去掉冒号）
  const rawId = useId();
  const renderId = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  const [svg, setSvg] = useState<string | null>(null);
  const [zoomSvg, setZoomSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [themeVersion, setThemeVersion] = useState(0);
  const [debouncedCode, setDebouncedCode] = useState(code);

  // 避免异步渲染竞态：只采纳最后一次渲染结果
  const renderSeq = useRef(0);
  const theme = useMemo(() => (isDarkTheme() ? "dark" : "default"), [themeVersion]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedCode(code), 250);
    return () => window.clearTimeout(timer);
  }, [code]);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeVersion((value) => value + 1));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const seq = ++renderSeq.current;

    async function render() {
      const source = debouncedCode.trim();
      if (!source) {
        setSvg(null);
        setFailed(false);
        return;
      }

      try {
        ensureInit();
        // 每次渲染前按当前主题重置，确保明暗切换后颜色正确
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme,
        });

        // 先做语法校验，不合法直接走回退（流式未完成时常见）
        await mermaid.parse(source);
        const { svg: rendered } = await mermaid.render(renderId, source);

        if (cancelled || seq !== renderSeq.current) return;
        setSvg(fitSvgWidth(rendered));
        setZoomSvg(fitSvgWidth(rendered, true));
        setFailed(false);
      } catch {
        if (cancelled || seq !== renderSeq.current) return;
        setSvg(null);
        setZoomSvg(null);
        setFailed(true);
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [debouncedCode, renderId, theme]);

  // 复制 mermaid 源码
  const handleCopy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // 下载 SVG 文件
  const handleDownloadSvg = () => {
    const downloadSvg = zoomSvg ?? svg;
    if (!downloadSvg) return;
    const blob = new Blob([downloadSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, "diagram.svg");
    URL.revokeObjectURL(url);
  };

  // 下载 PNG：把 SVG 画到离屏 canvas 再导出
  const handleDownloadPng = async () => {
    if (!svg) return;
    try {
      const png = await svgToPngDataUrl(zoomSvg ?? svg);
      triggerDownload(png, "diagram.png");
    } catch (error) {
      console.error("导出 PNG 失败:", error);
    }
  };

  // 渲染失败或源码不完整：回退为原始代码块
  if (failed || !svg) {
    return <CodeBlock code={code} language="mermaid" />;
  }

  return (
    <>
      <div className="app-scrollbar group relative my-4 overflow-x-auto rounded-lg border border-border bg-card p-4">
        {/* 渲染结果：根据图形比例自适应缩放并居中显示 */}
        <div
          className="mermaid-svg flex w-full justify-center [&_svg]:h-auto [&_svg]:max-w-full"
          // mermaid 产出的 SVG 已在 strict 模式下消毒，可安全注入
          dangerouslySetInnerHTML={{ __html: svg }}
        />

        {/* hover 工具条 */}
        <div className="absolute right-2 top-2 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <ToolbarButton label={copied ? "已复制" : "复制源码"} onClick={handleCopy}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </ToolbarButton>
          <ToolbarButton label="下载 SVG" onClick={handleDownloadSvg}>
            <Download className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="下载 PNG" onClick={() => void handleDownloadPng()}>
            <FileImage className="size-3.5" />
          </ToolbarButton>
          <ToolbarButton label="放大查看" onClick={() => setZoomOpen(true)}>
            <Maximize2 className="size-3.5" />
          </ToolbarButton>
        </div>
      </div>

      {/* 放大查看弹层 */}
      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent className="app-scrollbar max-h-[90vh] max-w-[90vw] overflow-auto sm:max-w-[90vw]">
          <div
            className="flex justify-center [&_svg]:h-auto [&_svg]:max-w-full"
            dangerouslySetInnerHTML={{ __html: zoomSvg ?? svg }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

// 工具条按钮
function ToolbarButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      title={label}
      onClick={onClick}
      className="h-7 gap-1 bg-card/80 px-2 text-xs text-muted-foreground backdrop-blur hover:text-foreground"
    >
      {children}
    </Button>
  );
}

// 触发浏览器下载
function triggerDownload(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// 把 SVG 字符串渲染到 canvas 并导出 PNG dataURL（2x 提升清晰度）
function svgToPngDataUrl(svg: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();

    img.onload = () => {
      const scale = 2;
      const width = img.width || 800;
      const height = img.height || 600;
      const canvas = document.createElement("canvas");
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error("无法创建画布上下文"));
        return;
      }
      // 白底，避免透明 PNG 在浅色处看不清
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("SVG 加载失败"));
    };
    img.src = url;
  });
}
