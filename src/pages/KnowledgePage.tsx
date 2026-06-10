// 知识库管理主页面
import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BookOpen,
  Database,
  Plus,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { PageHero } from "@/components/PageHero";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { getPathForFile, pickMultipleFiles } from "@/lib/electron/electron-api";
import type { KnowledgeBase } from "@/lib/knowledge";

import { KnowledgeBaseCard } from "@/components/knowledge/KnowledgeBaseCard";
import { KnowledgeFileCard } from "@/components/knowledge/KnowledgeFileCard";
import { CreateKnowledgeBaseModal } from "@/components/knowledge/CreateKnowledgeBaseModal";
import { KnowledgeSettingsModal } from "@/components/knowledge/KnowledgeSettingsModal";

const SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".txt",
  ".json",
  ".csv",
  ".log",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".sh",
  ".rb",
  ".php",
  ".sql",
  ".env",
  ".pdf",
  ".docx",
]);

export function KnowledgePage() {
  const knowledgeBases = useKnowledgeStore((state) => state.knowledgeBases);
  const currentKbId = useKnowledgeStore((state) => state.currentKbId);
  const loadKnowledgeBases = useKnowledgeStore((state) => state.loadKnowledgeBases);
  const setCurrentKnowledgeBase = useKnowledgeStore((state) => state.setCurrentKnowledgeBase);
  const isLoading = useKnowledgeStore((state) => state.isLoading);
  const error = useKnowledgeStore((state) => state.error);

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editingKnowledgeBase, setEditingKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    void loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  const currentKb = knowledgeBases.find((kb) => kb.id === currentKbId);
  const visibleKnowledgeBases = useMemo(
    () => filterKnowledgeBases(knowledgeBases, search),
    [knowledgeBases, search],
  );

  if (currentKbId && currentKb) {
    return <KnowledgeDetailPage knowledgeBase={currentKb} />;
  }

  return (
    <div className="app-scrollbar h-full overflow-y-auto bg-background">
      <div className="mx-auto w-full max-w-[1100px] px-6 py-6">
        <TopToolbar
          search={search}
          setSearch={setSearch}
          onCreateKnowledgeBase={() => setCreateModalOpen(true)}
          disabled={isLoading}
        />

        <PageHero
          title="知识库"
          bannerTitle="让助手记住你的专属资料"
          bannerDescription="导入你的资料，助手就能照着你的内容来回答。"
          icon={Database}
          kitLabel="Knowledge Kit"
        />

        {error && (
          <div className="mt-6 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {visibleKnowledgeBases.length > 0 ? (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visibleKnowledgeBases.map((kb) => (
              <KnowledgeBaseCard
                key={kb.id}
                knowledgeBase={kb}
                onClick={() => setCurrentKnowledgeBase(kb.id)}
                onEdit={() => setEditingKnowledgeBase(kb)}
              />
            ))}
          </div>
        ) : (
          <KnowledgeEmptyState
            hasKnowledgeBases={knowledgeBases.length > 0}
            onCreateKnowledgeBase={() => setCreateModalOpen(true)}
          />
        )}
      </div>

      <CreateKnowledgeBaseModal open={createModalOpen} onOpenChange={setCreateModalOpen} />
      {editingKnowledgeBase ? (
        <KnowledgeSettingsModal
          knowledgeBase={editingKnowledgeBase}
          open={Boolean(editingKnowledgeBase)}
          onOpenChange={(open) => {
            if (!open) setEditingKnowledgeBase(null);
          }}
        />
      ) : null}
    </div>
  );
}

function TopToolbar({
  search,
  setSearch,
  onCreateKnowledgeBase,
  disabled,
}: {
  search: string;
  setSearch: (value: string) => void;
  onCreateKnowledgeBase: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-end gap-2">
      <div className="relative w-[300px] max-w-full">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="h-9 w-full rounded-full border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-ring"
          placeholder="搜索知识库"
        />
      </div>
      <Button onClick={onCreateKnowledgeBase} disabled={disabled}>
        <Plus className="size-4" />
        新建知识库
      </Button>
    </div>
  );
}

function KnowledgeEmptyState({
  hasKnowledgeBases,
  onCreateKnowledgeBase,
}: {
  hasKnowledgeBases: boolean;
  onCreateKnowledgeBase: () => void;
}) {
  return (
    <div className="mt-6 flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card px-6 py-20 text-center">
      <BookOpen className="size-9 text-muted-foreground" />
      <h3 className="mt-4 text-base font-semibold">
        {hasKnowledgeBases ? "没有匹配的知识库" : "暂无知识库"}
      </h3>
      <p className="mt-2 max-w-[420px] text-sm leading-6 text-muted-foreground">
        {hasKnowledgeBases
          ? "换个关键词试试，或新建一个知识库来整理新的资料。"
          : "创建知识库并导入文档，让 AI 可以检索相关内容。"}
      </p>
      {!hasKnowledgeBases ? (
        <Button className="mt-5" onClick={onCreateKnowledgeBase}>
          <Plus className="size-4" />
          创建第一个知识库
        </Button>
      ) : null}
    </div>
  );
}

function KnowledgeDetailPage({ knowledgeBase }: { knowledgeBase: any }) {
  const setCurrentKnowledgeBase = useKnowledgeStore((state) => state.setCurrentKnowledgeBase);
  const currentFiles = useKnowledgeStore((state) => state.currentFiles);
  const addFiles = useKnowledgeStore((state) => state.addFiles);
  const removeFile = useKnowledgeStore((state) => state.removeFile);
  const rebuildFile = useKnowledgeStore((state) => state.rebuildFile);
  const rebuildCurrentKnowledgeBase = useKnowledgeStore(
    (state) => state.rebuildCurrentKnowledgeBase,
  );
  const checkCompatibility = useKnowledgeStore((state) => state.checkCompatibility);
  const reembedIncompatible = useKnowledgeStore((state) => state.reembedIncompatible);
  const isLoading = useKnowledgeStore((state) => state.isLoading);
  const error = useKnowledgeStore((state) => state.error);
  const [isDragActive, setIsDragActive] = useState(false);

  useEffect(() => {
    void setCurrentKnowledgeBase(knowledgeBase.id);
  }, [knowledgeBase.id, setCurrentKnowledgeBase]);

  useEffect(() => {
    // 每次加载时检查文件兼容性
    void checkCompatibility();
  }, [knowledgeBase.id, checkCompatibility]);

  const incompatibleCount = currentFiles.filter((f) => f.status === "incompatible").length;

  const importFiles = async (filePaths: string[]) => {
    const supportedFiles = filePaths.filter(isSupportedKnowledgeFilePath);
    if (supportedFiles.length === 0) {
      alert("未发现支持的文件");
      return;
    }
    await addFiles(supportedFiles);
  };

  const handleAddFiles = async () => {
    try {
      const files = await pickMultipleFiles();
      if (files && files.length > 0) {
        await importFiles(files);
      }
    } catch (error) {
      console.error("添加文件失败:", error);
    }
  };

  const handleDropFiles = async (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragActive(false);
    if (isLoading) return;

    try {
      const filePaths = Array.from(event.dataTransfer.files)
        .map((file) => getPathForFile(file))
        .filter(Boolean);
      await importFiles(filePaths);
    } catch (error) {
      console.error("拖入文件失败:", error);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (!isDragActive) setIsDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    const relatedTarget = event.relatedTarget;
    if (
      !relatedTarget ||
      !(relatedTarget instanceof Node) ||
      !event.currentTarget.contains(relatedTarget)
    ) {
      setIsDragActive(false);
    }
  };

  const handleRemoveFile = async (fileId: string) => {
    if (confirm("确定要删除此文件吗？")) {
      try {
        await removeFile(fileId);
      } catch (error) {
        console.error("删除文件失败:", error);
      }
    }
  };

  const handleReindexFile = async (fileId: string) => {
    try {
      await rebuildFile(fileId);
    } catch (error) {
      console.error("重建文件索引失败:", error);
    }
  };

  const handleRebuild = async () => {
    if (confirm("确定要重建索引吗？这将重新处理所有文件。")) {
      try {
        await rebuildCurrentKnowledgeBase();
      } catch (error) {
        console.error("重建索引失败:", error);
      }
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setCurrentKnowledgeBase(null)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ArrowLeft className="size-5" />
          </button>
          <div>
            <h1 className="text-xl font-semibold">{knowledgeBase.name}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={handleRebuild}
            disabled={isLoading || currentFiles.length === 0}
          >
            <RefreshCw className="size-4" />
            重建索引
          </Button>
          <Button onClick={handleAddFiles} disabled={isLoading}>
            <Upload className="size-4" />
            导入文件
          </Button>
        </div>
      </header>

      <main className="app-scrollbar flex-1 overflow-y-auto p-6">
        <div
          onDragEnter={handleDragOver}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDropFiles}
          className={`mb-4 flex items-center justify-between gap-4 rounded-lg border border-dashed px-4 py-4 transition-colors ${
            isDragActive
              ? "border-[#9b6fe0] bg-[#9b6fe0]/10"
              : "border-border bg-card"
          }`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Upload className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium">拖入文件到知识库</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                支持 PDF、DOCX、Markdown、TXT、JSON、代码文件等
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleAddFiles} disabled={isLoading}>
            选择文件
          </Button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {incompatibleCount > 0 && (
          <div className="mb-4 rounded-lg border border-amber-500/50 bg-amber-500/10 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-amber-600 dark:text-amber-400">
                  检测到 {incompatibleCount} 个文件向量不兼容
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  嵌入模型已更改,这些文件需要重新生成向量
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void reembedIncompatible()}
                disabled={isLoading}
              >
                <RefreshCw className="size-4" />
                重新嵌入
              </Button>
            </div>
          </div>
        )}

        {currentFiles.length === 0 ? (
          <EmptyState
            icon={Upload}
            title="暂无文件"
            description="导入文档文件到此知识库"
            actionLabel="导入文件"
            onAction={handleAddFiles}
          />
        ) : (
          <div className="space-y-2">
            {currentFiles.map((file) => (
              <KnowledgeFileCard
                key={file.id}
                file={file}
                onRemove={() => handleRemoveFile(file.id)}
                onReindex={() => handleReindexFile(file.id)}
                disabled={isLoading}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function filterKnowledgeBases(knowledgeBases: KnowledgeBase[], search: string) {
  const query = search.trim().toLowerCase();
  if (!query) return knowledgeBases;
  return knowledgeBases.filter((kb) =>
    `${kb.name} ${kb.description ?? ""}`.toLowerCase().includes(query),
  );
}

function isSupportedKnowledgeFilePath(filePath: string) {
  const normalized = filePath.trim().toLowerCase();
  if (!normalized) return false;
  const fileName = normalized.split(/[\\/]/).pop() ?? normalized;
  if (fileName === ".env") return true;
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex < 0) return false;
  return SUPPORTED_KNOWLEDGE_FILE_EXTENSIONS.has(fileName.slice(dotIndex));
}
