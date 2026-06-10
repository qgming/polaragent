// 知识库卡片组件
import { Trash2 } from "lucide-react";
import type { KnowledgeBase } from "@/lib/knowledge";
import { useKnowledgeStore } from "@/stores/knowledge-store";

interface KnowledgeBaseCardProps {
  knowledgeBase: KnowledgeBase;
  onClick: () => void;
}

export function KnowledgeBaseCard({ knowledgeBase, onClick }: KnowledgeBaseCardProps) {
  const deleteKnowledgeBase = useKnowledgeStore((state) => state.deleteKnowledgeBase);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`确定要删除知识库"${knowledgeBase.name}"吗？此操作不可恢复。`)) {
      try {
        await deleteKnowledgeBase(knowledgeBase.id);
      } catch (error) {
        console.error("删除知识库失败:", error);
      }
    }
  };

  return (
    <div
      onClick={onClick}
      className="cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-medium">{knowledgeBase.name}</h3>
          {knowledgeBase.description && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {knowledgeBase.description}
            </p>
          )}
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
        <div className="flex items-center gap-3">
          <span>{knowledgeBase.fileCount} 文件</span>
          <span>{knowledgeBase.chunkCount} 分块</span>
        </div>
        <button
          type="button"
          onClick={handleDelete}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          title="删除"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}
