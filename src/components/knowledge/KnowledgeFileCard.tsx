// 文件卡片组件
import { Trash2 } from "lucide-react";
import type { KnowledgeFile } from "@/lib/knowledge";

interface KnowledgeFileCardProps {
  file: KnowledgeFile;
  onRemove: () => void;
}

export function KnowledgeFileCard({ file, onRemove }: KnowledgeFileCardProps) {
  const statusColors = {
    pending: "bg-yellow-500/10 text-yellow-500",
    processing: "bg-blue-500/10 text-blue-500",
    ready: "bg-green-500/10 text-green-500",
    error: "bg-red-500/10 text-red-500",
    incompatible: "bg-amber-500/10 text-amber-500",
  };

  const statusLabels = {
    pending: "待处理",
    processing: "处理中",
    ready: "就绪",
    error: "错误",
    incompatible: "不兼容",
  };

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate font-medium text-sm">{file.name}</h4>
          <span
            className={`inline-flex items-center rounded px-2 py-0.5 text-xs ${statusColors[file.status]}`}
          >
            {statusLabels[file.status]}
          </span>
        </div>
        <p className="mt-1 truncate text-xs text-muted-foreground" title={file.path}>
          {file.path}
        </p>
        {file.error && <p className="mt-1 text-xs text-destructive">{file.error}</p>}
        <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span>{(file.size / 1024).toFixed(1)} KB</span>
          <span>{file.chunkCount} 分块</span>
          <span>{new Date(file.createdAt).toLocaleString("zh-CN")}</span>
        </div>
      </div>
      <button
        type="button"
        onClick={onRemove}
        className="ml-3 rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        title="删除"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
