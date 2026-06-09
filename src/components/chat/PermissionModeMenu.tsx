import { Bot, Eye, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { ToolPermissionMode } from "@/types/permissions";

const MODE_META: Record<
  ToolPermissionMode,
  { label: string; description: string; icon: typeof Eye }
> = {
  readonly: {
    label: "只读",
    description: "允许读取、搜索、查看和交互，阻止写入、删除和命令执行。",
    icon: Eye,
  },
  full: {
    label: "完全",
    description: "不做额外权限拦截，仍保留工具自身的安全校验。",
    icon: ShieldCheck,
  },
  ai_review: {
    label: "自动审查",
    description: "每次工具执行前由 AI 判断是否允许，不确定时拒绝。",
    icon: Bot,
  },
};

const MODES: ToolPermissionMode[] = ["readonly", "ai_review", "full"];

export function PermissionModeMenu({
  mode,
  onChange,
}: {
  mode: ToolPermissionMode;
  onChange: (mode: ToolPermissionMode) => void;
}) {
  const meta = MODE_META[mode];
  const Icon = meta.icon;

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className="h-7 gap-1.5 bg-muted/50 px-2 text-xs text-foreground/70 hover:bg-muted hover:text-foreground"
            >
              <Icon className="size-3.5" />
              <span>{meta.label}</span>
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{meta.description}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64">
        {MODES.map((item) => {
          const itemMeta = MODE_META[item];
          const ItemIcon = itemMeta.icon;
          return (
            <DropdownMenuItem key={item} onSelect={() => onChange(item)}>
              <ItemIcon className="size-4 text-muted-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{itemMeta.label}</div>
                <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
                  {itemMeta.description}
                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
