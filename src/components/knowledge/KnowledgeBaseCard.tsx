// 知识库卡片组件
import { BookOpen, FileText, Layers3, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { KnowledgeBase } from "@/lib/knowledge";
import { useKnowledgeStore } from "@/stores/knowledge-store";

interface KnowledgeBaseCardProps {
  knowledgeBase: KnowledgeBase;
  onClick: () => void;
  onEdit: () => void;
}

export function KnowledgeBaseCard({
  knowledgeBase,
  onClick,
  onEdit,
}: KnowledgeBaseCardProps) {
  const { t, i18n } = useTranslation("knowledge");
  const deleteKnowledgeBase = useKnowledgeStore((state) => state.deleteKnowledgeBase);

  const handleDelete = async () => {
    if (confirm(t("card.deleteConfirm", { name: knowledgeBase.name }))) {
      try {
        await deleteKnowledgeBase(knowledgeBase.id);
      } catch (error) {
        console.error(t("card.deleteFailed"), error);
      }
    }
  };

  return (
    <div
      onClick={onClick}
      className="group flex min-h-[132px] cursor-pointer flex-col rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm"
    >
      <div className="flex items-center gap-2.5">
        <BookOpen className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{knowledgeBase.name}</h3>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
              title={t("card.more")}
              aria-label={t("card.moreActions", { name: knowledgeBase.name })}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-28"
            onClick={(event) => event.stopPropagation()}
          >
            <DropdownMenuItem
              onClick={(event) => event.stopPropagation()}
              onSelect={onEdit}
            >
              {t("card.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(event) => event.stopPropagation()}
              onSelect={handleDelete}
            >
              {t("card.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {knowledgeBase.description ? (
        <p className="mt-2 line-clamp-2 h-10 overflow-hidden text-sm leading-5 text-muted-foreground">
          {knowledgeBase.description}
        </p>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 pt-4 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex items-center gap-1.5 tabular-nums">
            <FileText className="size-3.5" />
            {t("card.files", { count: knowledgeBase.fileCount })}
          </span>
          <span className="flex items-center gap-1.5 tabular-nums">
            <Layers3 className="size-3.5" />
            {t("card.chunks", { count: knowledgeBase.chunkCount })}
          </span>
        </div>
        <p className="shrink-0 truncate">
          {t("card.updated", { time: formatUpdatedAt(knowledgeBase.updatedAt, i18n.language) })}
        </p>
      </div>
    </div>
  );
}

function formatUpdatedAt(timestamp: number, language: string) {
  return new Date(timestamp).toLocaleDateString(language, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
