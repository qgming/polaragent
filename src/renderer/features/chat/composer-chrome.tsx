import { Check } from "lucide-react";
import { fieldInteractive, floating } from "@/renderer/components/assistant-ui/elements/surfaces";
import { cn } from "@/renderer/lib/utils";

/**
 * 输入框底部那一排 chip 的共用外壳。
 *
 * 单独一个文件是因为它现在有**两个**使用者：底排的四个 chip（Composer.tsx）与新会话页
 * 顶部那行项目 chip（composer-context.tsx）。放进任何一个使用者里都会让另一个反向依赖它 ——
 * 而这两处必须长得一样，用户读到的是同一排控件。
 */

/** chip 触发键：形状抄自 elements/composer.tsx 的 ComposerModelTrigger */
export const chipTrigger = cn(
  "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-foreground outline-none",
  "transition-colors hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]",
  "focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none",
);

/** 浮层菜单面板：Elements 的 floating 面（16 圆角 + 1.5 内边距） */
export const menuPanel = cn(floating, "rounded-2xl p-1.5");

/** 单选行：形状取自 ComposerMenuItem，选中态用 fieldInteractive 底 + 墨色勾（取自 model-picker） */
export function PickerItem({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-start text-[13.5px] outline-none transition-colors",
        "focus-visible:ring-1 focus-visible:ring-foreground/20",
        selected ? fieldInteractive : "hover:bg-foreground/[0.04]",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      <span className="flex w-4 shrink-0 justify-end">
        {selected && (
          <Check className="fade-in zoom-in-90 animate-in size-3.5 text-ink-2 duration-200" />
        )}
      </span>
    </button>
  );
}
