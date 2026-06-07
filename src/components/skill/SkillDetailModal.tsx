import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Code2,
  Eye,
  FileText,
  Folder,
  FolderOpen,
  ImageIcon,
  Loader2,
  RefreshCw,
  Save,
  X,
} from "lucide-react";

import { CodeBlock } from "@/components/markdown/CodeBlock";
import { MarkdownContent } from "@/components/markdown/MarkdownContent";
import {
  Modal,
  ModalBody,
  ModalContent,
  ModalTitle,
} from "@/components/ui/modal";
import { useToast } from "@/hooks/useToast";
import { fileUrl, listDirectoryEntries, openPath, readFile, writeFile } from "@/lib/electron/electron-api";
import { fileIconFor } from "@/lib/file-icons";
import { extOf, previewKindLabel, previewKindOf, type PreviewKind } from "@/lib/preview";
import { cn } from "@/lib/utils";
import type { SkillConfig } from "@/types/config";

type ViewMode = "code" | "preview";

interface TreeEntry {
  name: string;
  isDir: boolean;
  path: string;
}

interface SkillDetailModalProps {
  isOpen: boolean;
  skill: SkillConfig | null;
  onClose: () => void;
  onSaved?: () => void;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function parentDir(path: string): string {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(0, index) : normalized;
}

function joinPath(base: string, name: string): string {
  return `${normalizePath(base)}/${name}`;
}

function fileNameOf(path: string): string {
  return normalizePath(path).split("/").filter(Boolean).pop() || path;
}

function relativePath(root: string, path: string): string {
  const normalizedRoot = normalizePath(root);
  const normalizedPath = normalizePath(path);
  if (normalizedPath === normalizedRoot) return ".";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath;
}

function isTextKind(kind: PreviewKind) {
  return kind !== "image";
}

function defaultViewMode(kind: PreviewKind): ViewMode {
  return kind === "markdown" || kind === "html" || kind === "image" ? "preview" : "code";
}

export function SkillDetailModal({ isOpen, skill, onClose, onSaved }: SkillDetailModalProps) {
  const toast = useToast();
  const rootPath = useMemo(() => (skill?.filePath ? parentDir(skill.filePath) : ""), [skill?.filePath]);

  const [entriesByDir, setEntriesByDir] = useState<Record<string, TreeEntry[]>>({});
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState("");
  const [content, setContent] = useState("");
  const [draft, setDraft] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("preview");

  const selectedKind = useMemo<PreviewKind>(
    () => (selectedPath ? previewKindOf(selectedPath) : "unsupported"),
    [selectedPath],
  );
  const selectedExt = useMemo(() => extOf(selectedPath), [selectedPath]);
  const selectedName = selectedPath ? fileNameOf(selectedPath) : "";
  const selectedIsText = isTextKind(selectedKind);
  const dirty = selectedIsText && draft !== content;
  const SelectedIcon = useMemo(
    () => (selectedPath ? fileIconFor(selectedPath) : FileText),
    [selectedPath],
  );

  const loadDir = useCallback(async (dirPath: string) => {
    const normalizedDir = normalizePath(dirPath);
    setLoadingDirs((current) => new Set(current).add(normalizedDir));
    setTreeError(null);
    try {
      const entries = await listDirectoryEntries(normalizedDir);
      setEntriesByDir((current) => ({
        ...current,
        [normalizedDir]: entries.map((entry) => ({
          ...entry,
          path: joinPath(normalizedDir, entry.name),
        })),
      }));
    } catch (error) {
      setTreeError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingDirs((current) => {
        const next = new Set(current);
        next.delete(normalizedDir);
        return next;
      });
    }
  }, []);

  const loadSelectedFile = useCallback(async (path: string) => {
    const kind = previewKindOf(path);
    setSelectedPath(path);
    setViewMode(defaultViewMode(kind));
    setFileError(null);
    if (!isTextKind(kind)) {
      setContent("");
      setDraft("");
      setLoadingFile(false);
      return;
    }
    setLoadingFile(true);
    try {
      const text = await readFile(path);
      setContent(text);
      setDraft(text);
    } catch (error) {
      setContent("");
      setDraft("");
      setFileError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingFile(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen || !skill) return;
    setEntriesByDir({});
    setExpandedDirs(rootPath ? new Set([rootPath]) : new Set());
    setLoadingDirs(new Set());
    setTreeError(null);
    setSelectedPath("");
    setContent("");
    setDraft("");
    setFileError(null);
    setSaving(false);
    setViewMode("preview");
    if (!rootPath || !skill.filePath) {
      setTreeError("这个技能缺少 SKILL.md 路径，无法打开详情。");
      return;
    }
    void loadDir(rootPath);
    void loadSelectedFile(normalizePath(skill.filePath));
  }, [isOpen, loadDir, loadSelectedFile, rootPath, skill]);

  const toggleDir = async (dirPath: string) => {
    const normalizedDir = normalizePath(dirPath);
    const isExpanded = expandedDirs.has(normalizedDir);
    setExpandedDirs((current) => {
      const next = new Set(current);
      if (isExpanded) next.delete(normalizedDir);
      else next.add(normalizedDir);
      return next;
    });
    if (!isExpanded && !entriesByDir[normalizedDir]) await loadDir(normalizedDir);
  };

  const selectFile = async (path: string) => {
    if (path === selectedPath) return;
    if (dirty && !window.confirm("当前文件还有未保存的修改，确定切换文件吗？")) return;
    await loadSelectedFile(path);
  };

  const handleSave = async () => {
    if (!selectedPath || !selectedIsText || saving || !dirty) return;
    setSaving(true);
    setFileError(null);
    try {
      await writeFile(selectedPath, draft);
      setContent(draft);
      toast.success(`已保存：${selectedName}`);
      onSaved?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFileError(message);
      toast.error(`保存失败：${message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (dirty && !window.confirm("当前文件还有未保存的修改，确定关闭吗？")) return;
    onClose();
  };

  return (
    <Modal open={isOpen} onOpenChange={handleOpenChange}>
      <ModalContent
        size="2xl"
        showCloseButton={false}
        className="h-[min(760px,calc(100vh-4rem))] max-h-[calc(100vh-4rem)] max-w-[min(1180px,calc(100%-2rem))] rounded-lg bg-background"
      >
        <ModalTitle className="sr-only">编辑技能：{skill?.name || skill?.id || "未选择"}</ModalTitle>
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
          <ViewModeSwitch value={viewMode} onChange={setViewMode} disabled={!selectedPath || selectedKind === "image"} />

          <SelectedIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-sm font-medium" title={selectedPath || rootPath}>
            {selectedPath ? selectedName : skill?.name || skill?.id || "未选择"}
            {dirty ? <span className="ml-1 text-muted-foreground">•</span> : null}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            · {selectedPath ? previewKindLabel(selectedKind, selectedExt) : "Skill"}
          </span>
          {rootPath ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={rootPath}>
              {rootPath}
            </span>
          ) : null}

          <div className="ml-auto flex h-full items-center gap-0.5">
            {selectedIsText && viewMode === "code" ? (
              <ToolbarButton
                label={saving ? "保存中…" : "保存"}
                onClick={() => void handleSave()}
                disabled={!dirty || saving}
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              </ToolbarButton>
            ) : null}
            <ToolbarButton
              label="刷新"
              onClick={() => selectedPath && void loadSelectedFile(selectedPath)}
              disabled={!selectedPath || loadingFile}
            >
              <RefreshCw className={cn("size-4", loadingFile && "animate-spin")} />
            </ToolbarButton>
            <ToolbarButton label="打开技能目录" onClick={() => rootPath && void openPath(rootPath)} disabled={!rootPath}>
              <FolderOpen className="size-4" />
            </ToolbarButton>
            <ToolbarButton label="关闭" onClick={() => handleOpenChange(false)} close>
              <X className="size-4" />
            </ToolbarButton>
          </div>
        </header>
        <ModalBody className="grid overflow-hidden p-0 md:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="app-scrollbar min-h-0 overflow-auto border-b border-border bg-muted/20 p-2 md:border-b-0 md:border-r">
            {treeError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {treeError}
              </div>
            ) : null}
            {rootPath ? (
              <DirectoryContents
                entries={entriesByDir[normalizePath(rootPath)] ?? []}
                entriesByDir={entriesByDir}
                expandedDirs={expandedDirs}
                loadingDirs={loadingDirs}
                selectedPath={selectedPath}
                rootPath={rootPath}
                onToggleDir={(path) => void toggleDir(path)}
                onSelectFile={(path) => void selectFile(path)}
              />
            ) : null}
          </aside>
          <section className="flex min-h-0 flex-col overflow-hidden bg-background">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-sm">
              {selectedPath ? (
                <>
                  <SelectedFileIcon path={selectedPath} kind={selectedKind} />
                  <span className="min-w-0 truncate font-medium" title={selectedPath}>
                    {relativePath(rootPath, selectedPath)}
                  </span>
                  {dirty ? <span className="shrink-0 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">未保存</span> : null}
                </>
              ) : (
                <span className="text-muted-foreground">选择一个文件查看内容</span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <FileContentPane
                content={content}
                draft={draft}
                error={fileError}
                ext={selectedExt}
                filePath={selectedPath}
                kind={selectedKind}
                loading={loadingFile}
                viewMode={viewMode}
                onDraftChange={setDraft}
              />
            </div>
          </section>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
}

function DirectoryContents({
  entries,
  entriesByDir,
  expandedDirs,
  loadingDirs,
  selectedPath,
  rootPath,
  onToggleDir,
  onSelectFile,
}: {
  entries: TreeEntry[];
  entriesByDir: Record<string, TreeEntry[]>;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  selectedPath: string;
  rootPath: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  const normalizedRoot = normalizePath(rootPath);
  const isLoading = loadingDirs.has(normalizedRoot);

  if (isLoading && entries.length === 0) {
    return (
      <div className="flex items-center gap-2 px-2 py-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在读取…
      </div>
    );
  }

  if (!isLoading && entries.length === 0) {
    return <div className="px-2 py-2 text-sm text-muted-foreground">空目录</div>;
  }

  return (
    <div>
      {entries.map((entry) =>
        entry.isDir ? (
          <DirectoryTree
            key={entry.path}
            dirPath={entry.path}
            entriesByDir={entriesByDir}
            expandedDirs={expandedDirs}
            loadingDirs={loadingDirs}
            selectedPath={selectedPath}
            rootPath={rootPath}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
          />
        ) : (
          <FileTreeItem
            key={entry.path}
            entry={entry}
            level={0}
            selected={entry.path === selectedPath}
            onSelect={onSelectFile}
          />
        ),
      )}
    </div>
  );
}

function ViewModeSwitch({
  disabled,
  value,
  onChange,
}: {
  disabled?: boolean;
  value: ViewMode;
  onChange: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex shrink-0 items-center rounded-md border border-border p-0.5">
      <button
        type="button"
        onClick={() => onChange("code")}
        disabled={disabled}
        title="源码"
        className={cn(
          "flex size-6 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-45",
          value === "code" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Code2 className="size-3.5" />
        <span className="sr-only">源码</span>
      </button>
      <button
        type="button"
        onClick={() => onChange("preview")}
        disabled={disabled}
        title="预览"
        className={cn(
          "flex size-6 items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-45",
          value === "preview" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
        )}
      >
        <Eye className="size-3.5" />
        <span className="sr-only">预览</span>
      </button>
    </div>
  );
}

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

function DirectoryTree({
  dirPath,
  entriesByDir,
  expandedDirs,
  loadingDirs,
  selectedPath,
  rootPath,
  onToggleDir,
  onSelectFile,
  level = 0,
}: {
  dirPath: string;
  entriesByDir: Record<string, TreeEntry[]>;
  expandedDirs: Set<string>;
  loadingDirs: Set<string>;
  selectedPath: string;
  rootPath: string;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  level?: number;
}) {
  const normalizedDir = normalizePath(dirPath);
  const entries = entriesByDir[normalizedDir] ?? [];
  const isExpanded = expandedDirs.has(normalizedDir);
  const isLoading = loadingDirs.has(normalizedDir);
  const label = normalizedDir === normalizePath(rootPath) ? "技能目录" : fileNameOf(normalizedDir);

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggleDir(normalizedDir)}
        className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-sm hover:bg-muted"
        style={{ paddingLeft: `${8 + level * 14}px` }}
        title={normalizedDir}
      >
        {isExpanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        {isExpanded ? (
          <FolderOpen className="size-4 shrink-0 text-[#b7791f]" />
        ) : (
          <Folder className="size-4 shrink-0 text-[#b7791f]" />
        )}
        <span className="truncate">{label}</span>
        {isLoading ? <Loader2 className="ml-auto size-3.5 animate-spin" /> : null}
      </button>

      {isExpanded ? (
        <div>
          {entries.map((entry) =>
            entry.isDir ? (
              <DirectoryTree
                key={entry.path}
                dirPath={entry.path}
                entriesByDir={entriesByDir}
                expandedDirs={expandedDirs}
                loadingDirs={loadingDirs}
                selectedPath={selectedPath}
                rootPath={rootPath}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
                level={level + 1}
              />
            ) : (
              <FileTreeItem
                key={entry.path}
                entry={entry}
                level={level + 1}
                selected={entry.path === selectedPath}
                onSelect={onSelectFile}
              />
            ),
          )}
          {!isLoading && entries.length === 0 ? (
            <div
              className="px-2 py-1.5 text-xs text-muted-foreground"
              style={{ paddingLeft: `${32 + level * 14}px` }}
            >
              空目录
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function FileTreeItem({
  entry,
  level,
  selected,
  onSelect,
}: {
  entry: TreeEntry;
  level: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  const Icon = fileIconFor(entry.path);
  return (
    <button
      type="button"
      onClick={() => onSelect(entry.path)}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted",
        selected && "bg-accent text-accent-foreground hover:bg-accent",
      )}
      style={{ paddingLeft: `${24 + level * 14}px` }}
      title={entry.path}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{entry.name}</span>
    </button>
  );
}

function SelectedFileIcon({ path, kind }: { path: string; kind: PreviewKind }) {
  if (kind === "image") return <ImageIcon className="size-4 shrink-0" />;
  const Icon = path ? fileIconFor(path) : FileText;
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}

function FileContentPane({
  content,
  draft,
  error,
  ext,
  filePath,
  kind,
  loading,
  viewMode,
  onDraftChange,
}: {
  content: string;
  draft: string;
  error: string | null;
  ext: string;
  filePath: string;
  kind: PreviewKind;
  loading: boolean;
  viewMode: ViewMode;
  onDraftChange: (value: string) => void;
}) {
  if (!filePath) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">从左侧选择文件</div>;
  }

  if (error) return <div className="p-5 text-sm text-destructive">读取失败：{error}</div>;

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在读取…
      </div>
    );
  }

  if (kind === "image") return <ImagePreview filePath={filePath} />;

  if (viewMode === "code") {
    return (
      <textarea
        value={draft}
        onChange={(event) => onDraftChange(event.target.value)}
        spellCheck={false}
        className="app-scrollbar size-full resize-none overflow-auto bg-background p-5 font-mono text-sm leading-6 text-foreground outline-none"
      />
    );
  }

  if (kind === "html") {
    return <iframe title="HTML 预览" srcDoc={content} sandbox="allow-same-origin" className="size-full border-0 bg-white" />;
  }

  if (kind === "markdown") {
    return (
      <div className="app-scrollbar h-full overflow-auto px-8 py-6">
        <MarkdownContent content={content} />
      </div>
    );
  }

  return (
    <div className="app-scrollbar h-full overflow-auto px-4 py-2">
      <CodeBlock code={content} language={ext || "text"} />
    </div>
  );
}

function ImagePreview({ filePath }: { filePath: string }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let cancelled = false;
    setSrc("");
    void fileUrl(filePath).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div className="flex h-full items-center justify-center bg-muted/20 p-6">
      {src ? (
        <img src={src} alt={filePath} className="max-h-full max-w-full rounded-md object-contain" />
      ) : (
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
