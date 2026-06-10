// 知识库多选下拉菜单
import { useMemo } from "react";
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
import { cn } from "@/lib/utils";

interface KnowledgeBaseSelectorProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function KnowledgeBaseSelector({
  selectedIds,
  onChange,
}: KnowledgeBaseSelectorProps) {
  const allSources = useKnowledgeStore((state) => state.knowledgeBases);
  const sources = useMemo(
    () => allSources.filter((kb) => kb.enabled),
    [allSources],
  );

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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          title={selectedKnowledgeBase?.name ?? "知识库"}
          className={cn(
            "h-7 min-w-0 max-w-[180px] gap-1.5 px-2 hover:bg-muted hover:text-foreground",
            hasSelection
              ? "bg-muted text-foreground"
              : "bg-muted/50 text-foreground/70",
          )}
        >
          <BookOpen className="size-3.5 shrink-0" />
          {hasSelection && selectedKnowledgeBase ? (
            <span className="truncate text-sm">{selectedKnowledgeBase.name}</span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sources.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            暂无可用知识库
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
                    {kb.chunkCount} 块 · {kb.fileCount} 文档
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
              {selectedIds.length === sources.length ? "全部禁用" : "全部选中"}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
