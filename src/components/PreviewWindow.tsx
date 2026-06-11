// 文件预览窗口主组件 —— 独立窗口，按 URL 参数 path 读取并渲染文件
// src/components/PreviewWindow.tsx
//
// 视图模式（viewMode）：
//   preview -> 渲染效果（markdown 富文本 / html 网页 / 图片）
//   code    -> 源码视图，且即编辑模式（textarea，可改可 Ctrl+S 保存）
//
// 左上角分段开关 [</> | 👁] 仅在「有渲染效果」的类型（markdown/html）出现：
//   - 打开时默认 preview
//   - 纯文本/代码：本身即源码，固定 code 模式（可编辑），不显示开关
//   - 图片：固定 preview，不显示开关

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Code2,
  Eye,
  FolderOpen,
  Globe,
  ImageOff,
  Loader2,
  RefreshCw,
  Save,
  Search,
  X,
} from "lucide-react";

import { fileIconFor } from "@/lib/file-icons";
import { CodeBlock } from "@/components/markdown/CodeBlock";
import { MarkdownPreview } from "@/components/markdown/MarkdownPreview";
import { useTheme } from "@/hooks/useTheme";
import { initializeApp } from "@/lib/app-init";
import { fileUrl, readFile, writeFile, openPath, openExternal } from "@/lib/electron/electron-api";
import {
  extOf,
  previewKindLabel,
  previewKindOf,
  type PreviewKind,
} from "@/lib/preview";

import { runWindowAction } from "@/lib/electron/electron-window";
import { cn } from "@/lib/utils";

type ViewMode = "preview" | "code";

// 从路径取末段文件名
function fileNameOf(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

// 从路径取所在目录（供「在资源管理器打开」用）
function dirNameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || path;
}

export function PreviewWindow({ filePath }: { filePath: string }) {
  // 初始化配置 store（读取 config.json）
  useEffect(() => {
    void initializeApp();
  }, []);

  // 应用主题到 <html class="dark">（跟随主窗口配置）
  useTheme();

  const kind = useMemo<PreviewKind>(() => previewKindOf(filePath), [filePath]);
  const ext = useMemo(() => extOf(filePath), [filePath]);
  const fileName = useMemo(() => fileNameOf(filePath), [filePath]);
  const FileIco = useMemo(() => fileIconFor(filePath), [filePath]);

  // markdown/html 有「渲染效果」，可在 code/preview 间切换；其余类型无开关
  const hasRendered = kind === "markdown" || kind === "html";
  // 文本类（含纯文本/代码/markdown/html 源码）可编辑
  const canEdit = kind !== "image";

  const [content, setContent] = useState<string>("");
  const [draft, setDraft] = useState<string>(""); // 编辑中的草稿
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 默认视图：有渲染效果的类型默认 preview，纯文本/代码默认 code，图片走 preview
  const [viewMode, setViewMode] = useState<ViewMode>(
    hasRendered ? "preview" : canEdit ? "code" : "preview",
  );

  // code 视图即编辑态，草稿与已存内容不同则为「脏」
  const dirty = viewMode === "code" && draft !== content;

  // 设置窗口标题为文件名
  useEffect(() => {
    void runWindowAction((w) => w.setTitle(fileName));
  }, [fileName]);

  // 读取文件内容
  const load = useCallback(async () => {
    if (kind === "image") {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const text = await readFile(filePath);
      setContent(text);
      setDraft(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [filePath, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  // 保存草稿写回文件
  const handleSave = useCallback(async () => {
    if (!canEdit || saving) return;
    setSaving(true);
    try {
      await writeFile(filePath, draft);
      setContent(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [canEdit, saving, filePath, draft]);

  // Ctrl/Cmd+S 保存；Ctrl/Cmd+F 搜索；Esc 关搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (viewMode === "code") void handleSave();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
      if (e.key === "Escape" && searchOpen) {
        setSearchOpen(false);
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewMode, searchOpen, handleSave]);

  const closeWindow = () => {
    void runWindowAction((w) => w.close());
  };

  const openInSystemBrowser = useCallback(async () => {
    const url = await fileUrl(filePath);
    await openExternal(url);
  }, [filePath]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* ===== 标题栏（可拖拽） ===== */}
      <header
        data-electron-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3"
      >
        {/* 左上角：代码/预览 分段开关（仅 markdown/html 显示） */}
        {hasRendered ? (
          <ViewModeSwitch value={viewMode} onChange={setViewMode} />
        ) : null}

        <FileIco className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate text-sm font-medium" title={filePath}>
          {fileName}
          {dirty ? <span className="ml-1 text-muted-foreground">•</span> : null}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          · {previewKindLabel(kind, ext)}
        </span>

        {/* 右侧工具栏（不参与窗口拖拽） */}
        <div className="ml-auto flex h-full items-center gap-0.5">
          {/* 保存：处于 code 编辑视图时显示 */}
          {canEdit && viewMode === "code" ? (
            <ToolbarButton
              label={saving ? "保存中…" : "保存 (Ctrl+S)"}
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
            </ToolbarButton>
          ) : null}

          {kind !== "image" ? (
            <ToolbarButton
              label="页内搜索 (Ctrl+F)"
              onClick={() => setSearchOpen((v) => !v)}
              active={searchOpen}
            >
              <Search className="size-4" />
            </ToolbarButton>
          ) : null}

          <ToolbarButton label="刷新" onClick={() => void load()}>
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </ToolbarButton>

          <ToolbarButton
            label="在文件资源管理器中打开"
            onClick={() => void openPath(dirNameOf(filePath))}
          >
            <FolderOpen className="size-4" />
          </ToolbarButton>

          {kind === "html" ? (
            <ToolbarButton
              label="使用系统浏览器打开"
              onClick={() => void openInSystemBrowser()}
            >
              <Globe className="size-4" />
            </ToolbarButton>
          ) : null}

          <ToolbarButton label="关闭" onClick={closeWindow} close>
            <X className="size-4" />
          </ToolbarButton>
        </div>
      </header>

      {/* ===== 页内搜索条 ===== */}
      {searchOpen ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="在文件中查找…"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <button
            type="button"
            onClick={() => {
              setSearchOpen(false);
              setQuery("");
            }}
            className="text-muted-foreground hover:text-foreground"
            title="关闭搜索"
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : null}

      {/* ===== 内容区 ===== */}
      <main
        className={cn(
          "min-h-0 flex-1",
          viewMode === "code" || kind === "html"
            ? "overflow-hidden"
            : "app-scrollbar overflow-auto",
        )}
      >
        {error ? (
          <div className="p-6 text-sm text-destructive">读取失败：{error}</div>
        ) : loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            正在读取…
          </div>
        ) : (
          <PreviewContent
            kind={kind}
            ext={ext}
            filePath={filePath}
            content={content}
            draft={draft}
            viewMode={viewMode}
            onDraftChange={setDraft}
            query={searchOpen ? query : ""}
          />
        )}
      </main>
    </div>
  );
}

// 左上角「代码 / 预览」分段开关
function ViewModeSwitch({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
      <button
        type="button"
        onClick={() => onChange("code")}
        title="代码（可编辑）"
        className={cn(
          "flex size-6 items-center justify-center rounded transition-colors",
          value === "code"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Code2 className="size-3.5" />
        <span className="sr-only">代码</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("preview")}
        title="预览"
        className={cn(
          "flex size-6 items-center justify-center rounded transition-colors",
          value === "preview"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Eye className="size-3.5" />
        <span className="sr-only">预览</span>
      </button>
    </div>
  );
}

// 标题栏工具按钮
function ToolbarButton({
  children,
  label,
  onClick,
  disabled,
  active,
  close,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  close?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      className={cn(
        "flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-muted text-foreground",
        close && "hover:bg-destructive hover:text-white",
      )}
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}

// 内容渲染：按视图模式与类别分发
function PreviewContent({
  kind,
  ext,
  filePath,
  content,
  draft,
  viewMode,
  onDraftChange,
  query,
}: {
  kind: PreviewKind;
  ext: string;
  filePath: string;
  content: string;
  draft: string;
  viewMode: ViewMode;
  onDraftChange: (value: string) => void;
  query: string;
}) {
  // code 视图 = 可编辑 textarea（纯文本/代码/markdown/html 源码统一走这里）
  if (viewMode === "code") {
    return (
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        spellCheck={false}
        className="app-scrollbar size-full resize-none overflow-auto bg-background p-6 font-mono text-sm leading-6 text-foreground outline-none"
      />
    );
  }

  // 以下为 preview 视图
  if (kind === "image") {
    return <ImagePreview filePath={filePath} />;
  }

  if (kind === "html") {
    // 本地 HTML 文件用 src，以支持加载相对路径的 CSS/JS 资源
    return <HtmlPreview filePath={filePath} />;
  }

  if (kind === "markdown") {
    return (
      <div className="mx-auto max-w-4xl px-8 py-6">
        <MarkdownPreview content={content} filePath={filePath} />
      </div>
    );
  }

  // 兜底：code/纯文本类型在 preview 视图（理论上不会进入，因其默认 code 且无开关）
  return (
    <div className="px-2 py-2">
      <CodeWithSearch code={content} language={ext || "text"} query={query} />
    </div>
  );
}

function ImagePreview({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState("");
  // 图片加载失败（文件损坏、格式不支持、内容为空等）时切换为友好提示。
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // 本地文件需要转换为 file:// URL
    let cancelled = false;
    setFailed(false);
    void fileUrl(filePath).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      {failed ? (
        <div className="flex max-w-sm flex-col items-center gap-2 text-center text-muted-foreground">
          <ImageOff className="size-10 opacity-60" />
          <p className="text-sm font-medium text-foreground">无法显示这张图片</p>
          <p className="text-xs">
            图片可能已损坏或格式不受支持，可尝试用其他看图软件打开该文件。
          </p>
        </div>
      ) : src ? (
        <img
          src={src}
          alt={fileNameOf(filePath)}
          onError={() => setFailed(true)}
          className="max-h-full max-w-full object-contain"
        />
      ) : null}
    </div>
  );
}

// HTML 预览：使用 file:// URL 以支持加载本地资源
function HtmlPreview({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    void fileUrl(filePath).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return src ? (
    <iframe
      title="HTML 预览"
      src={src}
      sandbox="allow-scripts allow-forms allow-modals allow-popups"
      referrerPolicy="no-referrer"
      className="size-full border-0 bg-white dark:bg-background"
    />
  ) : null;
}

// 代码/文本只读展示,支持搜索词高亮（命中处黄色背景）
function CodeWithSearch({
  code,
  language,
  query,
}: {
  code: string;
  language: string;
  query: string;
}) {
  return <CodeBlock code={code} language={language} searchQuery={query} />;
}
