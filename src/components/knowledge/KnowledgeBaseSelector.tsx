// 知识库多选下拉菜单
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { useResponsiveWidth } from "@/hooks/useResponsiveWidth";
import { cn } from "@/lib/utils";

interface KnowledgeBaseSelectorProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function KnowledgeBaseSelector({
  selectedIds,
  onChange,
}: KnowledgeBaseSelectorProps) {
  const { t } = useTranslation("knowledge");
  const allSources = useKnowledgeStore((state) => state.knowledgeBases);
  const sources = useMemo(
    () => allSources.filter((kb) => kb.enabled),
    [allSources],
  );
  const breakpoint = useResponsiveWidth();

  const handleToggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((i) => i !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleToggleAll = () => {
    if (selectedIds.length === sources.length) {
      onChange([]);
    } else {
      onChange(sources.map((s) => s.id));
    }
  };

  const count = selectedIds.length;
  const hasSelection = count > 0;
  const selectedKnowledgeBase = useMemo(
    () => allSources.find((kb) => kb.id === selectedIds[0]),
    [allSources, selectedIds],
  );

  // narrow: 只显示图标; medium/wide: 显示图标+文字
  const showText = breakpoint !== "narrow";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          title={selectedKnowledgeBase?.name ?? t("selector.title")}
          className={cn(
            "h-7 hover:bg-muted hover:text-foreground transition-colors",
            hasSelection
              ? "bg-muted text-foreground"
              : "bg-muted/50 text-foreground/70",
            // narrow 模式：纯图标按钮（与 ComposerToolbar 一致）
            showText ? "gap-1.5 px-2" : "size-7 min-w-0 justify-center rounded-md px-0",
          )}
        >
          <BookOpen className={showText ? "size-3.5 shrink-0" : "size-4"} />
          {showText && hasSelection && selectedKnowledgeBase ? (
            <span className="truncate text-sm">{selectedKnowledgeBase.name}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sources.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            {t("selector.empty")}
          </div>
        ) : (
          <>
            {sources.map((kb) => (
              <DropdownMenuItem
                key={kb.id}
                onSelect={(event) => {
                  event.preventDefault();
                  handleToggle(kb.id);
                }}
                className={cn(
                  "items-start",
                  selectedIds.includes(kb.id) && "bg-muted text-foreground",
                )}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{kb.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {t("selector.itemMeta", { chunks: kb.chunkCount, files: kb.fileCount })}
                  </span>
                </div>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                handleToggleAll();
              }}
              className={cn(
                selectedIds.length === sources.length && "bg-muted text-foreground",
              )}
            >
              {selectedIds.length === sources.length ? t("selector.disableAll") : t("selector.selectAll")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
