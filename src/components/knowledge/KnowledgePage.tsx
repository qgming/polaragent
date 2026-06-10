// 知识库管理主页面
import { useEffect, useState } from "react";
import { BookOpen, Plus, ArrowLeft, Upload, RefreshCw, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { pickMultipleFiles } from "@/lib/electron/electron-api";

import { KnowledgeBaseCard } from "./KnowledgeBaseCard";
import { KnowledgeFileCard } from "./KnowledgeFileCard";
import { CreateKnowledgeBaseModal } from "./CreateKnowledgeBaseModal";
import { KnowledgeSettingsModal } from "./KnowledgeSettingsModal";

export function KnowledgePage() {
  const knowledgeBases = useKnowledgeStore((state) => state.knowledgeBases);
  const currentKbId = useKnowledgeStore((state) => state.currentKbId);
  const loadKnowledgeBases = useKnowledgeStore((state) => state.loadKnowledgeBases);
  const setCurrentKnowledgeBase = useKnowledgeStore((state) => state.setCurrentKnowledgeBase);
  const isLoading = useKnowledgeStore((state) => state.isLoading);
  const error = useKnowledgeStore((state) => state.error);

  const [createModalOpen, setCreateModalOpen] = useState(false);

  useEffect(() => {
    void loadKnowledgeBases();
  }, [loadKnowledgeBases]);

  const currentKb = knowledgeBases.find((kb) => kb.id === currentKbId);

  if (currentKbId && currentKb) {
    return <KnowledgeDetailPage knowledgeBase={currentKb} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">知识库</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理可被 AI 检索的文档与资料</p>
        </div>
        <Button onClick={() => setCreateModalOpen(true)} disabled={isLoading}>
          <Plus className="size-4" />
          新建知识库
        </Button>
      </header>

      <main className="app-scrollbar flex-1 overflow-y-auto p-6">
        {error && (
          <div className="mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
            {error}
          </div>
        )}

        {knowledgeBases.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="暂无知识库"
            description="创建知识库并导入文档，让 AI 可以检索相关内容"
            actionLabel="创建第一个知识库"
            onAction={() => setCreateModalOpen(true)}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {knowledgeBases.map((kb) => (
              <KnowledgeBaseCard
                key={kb.id}
                knowledgeBase={kb}
                onClick={() => {
                  console.log("KnowledgeBaseCard clicked, kb.id:", kb.id, "kb:", kb);
                  setCurrentKnowledgeBase(kb.id);
                }}
              />
            ))}
          </div>
        )}
      </main>

      <CreateKnowledgeBaseModal open={createModalOpen} onOpenChange={setCreateModalOpen} />
    </div>
  );
}

function KnowledgeDetailPage({ knowledgeBase }: { knowledgeBase: any }) {
  const setCurrentKnowledgeBase = useKnowledgeStore((state) => state.setCurrentKnowledgeBase);
  const currentFiles = useKnowledgeStore((state) => state.currentFiles);
  const addFiles = useKnowledgeStore((state) => state.addFiles);
  const removeFile = useKnowledgeStore((state) => state.removeFile);
  const rebuildCurrentKnowledgeBase = useKnowledgeStore(
    (state) => state.rebuildCurrentKnowledgeBase,
  );
  const checkCompatibility = useKnowledgeStore((state) => state.checkCompatibility);
  const reembedIncompatible = useKnowledgeStore((state) => state.reembedIncompatible);
  const isLoading = useKnowledgeStore((state) => state.isLoading);
  const error = useKnowledgeStore((state) => state.error);

  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    void setCurrentKnowledgeBase(knowledgeBase.id);
  }, [knowledgeBase.id, setCurrentKnowledgeBase]);

  useEffect(() => {
    // 每次加载时检查文件兼容性
    void checkCompatibility();
  }, [knowledgeBase.id, checkCompatibility]);

  const incompatibleCount = currentFiles.filter((f) => f.status === "incompatible").length;

  const handleAddFiles = async () => {
    try {
      const files = await pickMultipleFiles();
      if (files && files.length > 0) {
        await addFiles(files);
      }
    } catch (error) {
      console.error("添加文件失败:", error);
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
            {knowledgeBase.description && (
              <p className="mt-1 text-sm text-muted-foreground">{knowledgeBase.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setSettingsOpen(true)} disabled={isLoading}>
            <Settings className="size-4" />
            设置
          </Button>
          <Button onClick={handleAddFiles} disabled={isLoading}>
            <Upload className="size-4" />
            导入文件
          </Button>
        </div>
      </header>

      <main className="app-scrollbar flex-1 overflow-y-auto p-6">
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

        <div className="mb-4 flex items-center justify-between rounded-lg bg-muted p-3 text-sm">
          <div className="flex items-center gap-4 text-muted-foreground">
            <span>{knowledgeBase.fileCount} 文件</span>
            <span>{knowledgeBase.chunkCount} 分块</span>
            <span>最后更新 {new Date(knowledgeBase.updatedAt).toLocaleString("zh-CN")}</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRebuild}
            disabled={isLoading || currentFiles.length === 0}
          >
            <RefreshCw className="size-4" />
            重建索引
          </Button>
        </div>

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
              />
            ))}
          </div>
        )}
      </main>

      {settingsOpen && (
        <KnowledgeSettingsModal
          knowledgeBase={knowledgeBase}
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
        />
      )}
    </div>
  );
}
