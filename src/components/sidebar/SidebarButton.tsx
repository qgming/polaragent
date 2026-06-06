// 侧边栏导航按钮（主导航与「设置」共用）
import { cn } from "@/lib/utils";
import type { IconComponent } from "@/lib/navigation";

export function SidebarButton({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: IconComponent;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
        active
          ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
          : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <Icon className="size-[18px] shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  );
}
