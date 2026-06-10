// 文件卡片组件
import { RefreshCw, Trash2 } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { KnowledgeFile } from "@/lib/knowledge";

interface KnowledgeFileCardProps {
  file: KnowledgeFile;
  onRemove: () => void;
  onReindex: () => void;
  disabled?: boolean;
}

export function KnowledgeFileCard({
  file,
  onRemove,
  onReindex,
  disabled = false,
}: KnowledgeFileCardProps) {
  const statusLabels = {
    pending: "待处理",
    processing: "索引中",
    ready: "就绪",
    error: "错误",
    incompatible: "异常",
  };
  const statusDotColors = {
    pending: "bg-amber-400",
    processing: "bg-amber-400",
    ready: "bg-emerald-500",
    error: "bg-red-500",
    incompatible: "bg-amber-400",
  };
  const isProcessing = file.status === "processing";

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="truncate font-medium text-sm">{file.name}</h4>
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
      <div className="ml-3 flex items-center gap-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <button
                type="button"
                onClick={onReindex}
                disabled={disabled || isProcessing}
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                aria-label={`重新索引 ${file.name}`}
              >
                <RefreshCw className={`size-4 ${isProcessing ? "animate-spin" : ""}`} />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{isProcessing ? "正在索引" : "重新索引该文件"}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`size-2.5 shrink-0 rounded-full ${statusDotColors[file.status]}`}
              aria-label={`状态：${statusLabels[file.status]}`}
            />
          </TooltipTrigger>
          <TooltipContent>状态：{statusLabels[file.status]}</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          title="删除"
          aria-label={`删除 ${file.name}`}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}
