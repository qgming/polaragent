import { Bot, Eye, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

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
import { useResponsiveWidth } from "@/hooks/useResponsiveWidth";
import type { ToolPermissionMode } from "@/types/permissions";

const MODE_META: Record<
  ToolPermissionMode,
  { labelKey: string; descriptionKey: string; icon: typeof Eye }
> = {
  readonly: {
    labelKey: "permission.readonly.label",
    descriptionKey: "permission.readonly.description",
    icon: Eye,
  },
  full: {
    labelKey: "permission.full.label",
    descriptionKey: "permission.full.description",
    icon: ShieldCheck,
  },
  ai_review: {
    labelKey: "permission.aiReview.label",
    descriptionKey: "permission.aiReview.description",
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
  const { t } = useTranslation("chat");
  const meta = MODE_META[mode];
  const Icon = meta.icon;
  const breakpoint = useResponsiveWidth();

  // narrow: 只显示图标; medium/wide: 显示图标+文字
  const showText = breakpoint !== "narrow";

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              className={
                showText
                  ? "h-7 gap-1.5 bg-muted/50 px-2 text-xs text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                  : "size-7 justify-center rounded-md p-0 bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
              }
            >
              <Icon className="size-4" />
              {showText ? <span>{t(meta.labelKey)}</span> : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{t(meta.descriptionKey)}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" className="w-64">
        {MODES.map((item) => {
          const itemMeta = MODE_META[item];
          const ItemIcon = itemMeta.icon;
          return (
            <DropdownMenuItem key={item} onSelect={() => onChange(item)}>
              <ItemIcon className="size-4 text-muted-foreground" />
              <div className="min-w-0">
	                <div className="text-sm font-medium">{t(itemMeta.labelKey)}</div>
	                <div className="mt-0.5 text-xs leading-4 text-muted-foreground">
	                  {t(itemMeta.descriptionKey)}
	                </div>
              </div>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
