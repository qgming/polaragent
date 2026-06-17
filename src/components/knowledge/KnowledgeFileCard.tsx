// 文件卡片组件
import { RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t, i18n } = useTranslation("knowledge");
  const statusLabels = {
    pending: t("file.statuses.pending"),
    processing: t("file.statuses.processing"),
    ready: t("file.statuses.ready"),
    error: t("file.statuses.error"),
    incompatible: t("file.statuses.incompatible"),
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
          <span>{t("file.chunks", { count: file.chunkCount })}</span>
          <span>{new Date(file.createdAt).toLocaleString(i18n.language)}</span>
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
                aria-label={t("file.reindex", { name: file.name })}
              >
                <RefreshCw className={`size-4 ${isProcessing ? "animate-spin" : ""}`} />
              </button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{isProcessing ? t("file.indexing") : t("file.reindexTooltip")}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={`size-2.5 shrink-0 rounded-full ${statusDotColors[file.status]}`}
              aria-label={t("file.status", { status: statusLabels[file.status] })}
            />
          </TooltipTrigger>
          <TooltipContent>{t("file.status", { status: statusLabels[file.status] })}</TooltipContent>
        </Tooltip>
        <button
          type="button"
          onClick={onRemove}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
          title={t("file.delete")}
          aria-label={t("file.deleteLabel", { name: file.name })}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}
