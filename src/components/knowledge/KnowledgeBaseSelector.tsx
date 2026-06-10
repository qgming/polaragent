// 知识库多选下拉菜单
import { useMemo } from "react";
import { BookOpen, Check, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { cn } from "@/lib/utils";

interface KnowledgeBaseSelectorProps {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onOpenSettings?: () => void;
}

export function KnowledgeBaseSelector({
  selectedIds,
  onChange,
  onOpenSettings,
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          className={cn(
            "h-7 gap-1 px-2",
            hasSelection
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground"
          )}
        >
          <BookOpen className="size-3.5" />
          {hasSelection ? (
            <>
              <span className="text-xs">{count}</span>
              <Check className="size-3" />
            </>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sources.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            暂无已启用的知识库
          </div>
        ) : (
          <>
            {sources.map((kb) => (
              <DropdownMenuCheckboxItem
                key={kb.id}
                checked={selectedIds.includes(kb.id)}
                onCheckedChange={() => handleToggle(kb.id)}
              >
                <div className="flex flex-col gap-0.5">
                  <span className="text-sm">{kb.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {kb.chunkCount} 块 · {kb.fileCount} 文档
                  </span>
                </div>
              </DropdownMenuCheckboxItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuCheckboxItem
              checked={selectedIds.length === sources.length}
              onCheckedChange={handleToggleAll}
            >
              {selectedIds.length === sources.length ? "全部禁用" : "全部选中"}
            </DropdownMenuCheckboxItem>
          </>
        )}
        {onOpenSettings && (
          <>
            <DropdownMenuSeparator />
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Settings className="size-4" />
              管理知识库
            </button>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
