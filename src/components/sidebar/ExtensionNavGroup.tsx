// 「扩展」折叠导航组：收纳技能 / 工具 / 助手 / 团队
// 展开/收起状态持久化到 localStorage，重启后保留。
import { ChevronRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";

import { extensionNav, type PageId } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "polaragent-sidebar-extension-expanded";

function readStoredExpanded(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(STORAGE_KEY) === "1";
}

export function ExtensionNavGroup({
  activePage,
  activeTeamId,
  onOpenPage,
}: {
  activePage: PageId;
  activeTeamId?: string;
  onOpenPage: (page: PageId) => void;
}) {
  // 当前是否有子项处于激活态（团队页另需排除团队会话激活的情况，与原顶层逻辑一致）
  const hasActiveChild = extensionNav.items.some(
    (item) => activePage === item.id && !activeTeamId,
  );

  const [expanded, setExpanded] = useState(readStoredExpanded);

  // 子项被激活时自动展开，避免高亮项被折叠隐藏
  useEffect(() => {
    if (hasActiveChild) setExpanded(true);
  }, [hasActiveChild]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, expanded ? "1" : "0");
  }, [expanded]);

  const GroupIcon = extensionNav.icon;

  return (
    <div>
      {/* 分组标题行：点击展开/收起 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
          "text-sidebar-foreground hover:bg-muted hover:text-foreground",
        )}
      >
        <GroupIcon className="size-[18px] shrink-0" />
        <span className="truncate">{extensionNav.label}</span>
        <motion.span
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="ml-auto flex shrink-0 text-muted-foreground"
        >
          <ChevronRight className="size-4" />
        </motion.span>
      </button>

      {/* 子项列表：左侧竖线缩进，展开/收起带高度动画 */}
      <AnimatePresence initial={false}>
        {expanded ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="ml-[18px] mt-1 space-y-1 border-l border-border pl-2">
              {extensionNav.items.map((item) => {
                const active = activePage === item.id && !activeTeamId;
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onOpenPage(item.id)}
                    className={cn(
                      "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors",
                      active
                        ? "bg-black/[0.06] text-foreground dark:bg-white/[0.08]"
                        : "text-sidebar-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    <Icon className="size-[18px] shrink-0" />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
