import { Monitor, Moon, Sun } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { ThemeMode } from "@/shared/contracts/common";

// 主题切换顺序：浅色 → 深色 → 跟随系统 → 循环
const THEME_ORDER: readonly ThemeMode[] = ["light", "dark", "system"];

// 各模式的图标与文案 key（词条：app.themeLight / themeDark / themeSystem）
const THEME_META: Record<
  ThemeMode,
  {
    Icon: typeof Sun;
    labelKey: "app.themeLight" | "app.themeDark" | "app.themeSystem";
  }
> = {
  light: { Icon: Sun, labelKey: "app.themeLight" },
  dark: { Icon: Moon, labelKey: "app.themeDark" },
  system: { Icon: Monitor, labelKey: "app.themeSystem" },
};

export function ThemeToggle() {
  const { t } = useTranslation();
  // 设置未加载完成前按 system 兜底（Monitor 图标）
  const theme = useSettingsStore((s) => s.settings?.theme ?? "system");
  const update = useSettingsStore((s) => s.update);
  const { Icon, labelKey } = THEME_META[theme];

  // 主题应用由 settings-store 负责：update 内部落盘并调用 applyTheme（切换 html.dark）
  const cycle = () => {
    // noUncheckedIndexedAccess 下索引可能为 undefined，兜底回 "light"
    const next = THEME_ORDER[(THEME_ORDER.indexOf(theme) + 1) % THEME_ORDER.length] ?? "light";
    void update({ theme: next });
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t(labelKey)}
          onClick={cycle}
        >
          <Icon className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{t(labelKey)}</TooltipContent>
    </Tooltip>
  );
}
