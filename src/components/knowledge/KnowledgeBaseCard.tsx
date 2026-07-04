// 知识库卡片组件
import { Clock3, FileText, Layers3, MoreHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
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
  const updateKnowledgeBase = useKnowledgeStore((state) => state.updateKnowledgeBase);

  const handleDelete = async () => {
    if (confirm(t("card.deleteConfirm", { name: knowledgeBase.name }))) {
      try {
        await deleteKnowledgeBase(knowledgeBase.id);
      } catch (error) {
        console.error(t("card.deleteFailed"), error);
      }
    }
  };

  const handleToggleEnabled = async (enabled: boolean) => {
    try {
      await updateKnowledgeBase(knowledgeBase.id, { enabled });
    } catch (error) {
      console.error(t("form.updateFailed"), error);
    }
  };

  return (
    <div
      onClick={onClick}
      className="group flex min-h-[144px] cursor-pointer flex-col rounded-xl border border-border bg-card p-3.5 text-left transition-all hover:border-[#9b6fe0]/30 hover:shadow-sm"
    >
      <div className="flex items-start justify-between gap-2.5">
        <Switch
          checked={knowledgeBase.enabled}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={(checked) => void handleToggleEnabled(checked)}
          aria-label={knowledgeBase.enabled ? t("card.disable") : t("card.enable")}
        />
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

      <div className="mt-3 min-w-0 flex-1">
        <h3 className="truncate text-base font-semibold leading-6 text-foreground">
          {knowledgeBase.name}
        </h3>

        <div className="mt-4 border-t border-border/80 pt-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground tabular-nums">
              <FileText className="size-4 shrink-0" />
              {t("card.files", { count: knowledgeBase.fileCount })}
            </span>
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground tabular-nums">
              <Layers3 className="size-4 shrink-0" />
              {t("card.chunks", { count: knowledgeBase.chunkCount })}
            </span>
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm font-medium text-muted-foreground">
              <Clock3 className="size-4 shrink-0" />
              <span className="truncate">
                {t("card.updated", { time: formatUpdatedAt(knowledgeBase.updatedAt, i18n.language) })}
              </span>
            </span>
          </div>
        </div>
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
