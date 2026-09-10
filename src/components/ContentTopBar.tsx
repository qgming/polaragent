// 内容区顶栏：折叠按钮 + 会话标题 + 功能按钮 + 窗口控制
// src/components/ContentTopBar.tsx

import {
  BarChart3,
  CopyMinus,
  Minus,
  PanelLeftOpen,
  Search,
  Square as SquareIcon,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { IconButton } from "@/components/IconButton";
import { SessionStatsPopover } from "@/components/chat/SessionStatsPopover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getElectronWindowApi,
  refreshMaximizedState,
  runWindowAction,
} from "@/lib/electron/electron-window";
import { cn } from "@/lib/utils";

export function ContentTopBar({
  title,
  onOpenSearch,
  onToggleSidebar,
  showStats,
  sidebarCollapsed,
  statsThreadId,
}: {
  title: string;
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  showStats: boolean;
  sidebarCollapsed: boolean;
  statsThreadId?: string;
}) {
  return (
    <header
      data-electron-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 bg-white pl-1 dark:bg-background"
    >
      <div className="flex h-full min-w-0 items-center px-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          title="展开侧边栏"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-all duration-200 hover:bg-muted hover:text-foreground",
            sidebarCollapsed
              ? "ml-0 w-8 opacity-100"
              : "ml-0 w-0 opacity-0 pointer-events-none",
          )}
        >
          <PanelLeftOpen className="size-4" />
        </button>
        <span className="ml-1 truncate text-sm font-medium text-foreground">
          {title}
        </span>
      </div>

      <div className="flex h-full items-center">
        <IconButton className="size-8" label="搜索会话" onClick={onOpenSearch}>
          <Search className="size-4" />
        </IconButton>
        {showStats ? <SessionStatsButton threadId={statsThreadId} /> : null}
        <div className="mx-1.5 h-4 w-px bg-border" />
        <WindowControls />
      </div>
    </header>
  );
}

function SessionStatsButton({ threadId }: { threadId?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
          title="会话统计"
          type="button"
        >
          <BarChart3 className="size-4" />
          <span className="sr-only">会话统计</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 p-0">
        <SessionStatsPopover threadId={threadId} />
      </PopoverContent>
    </Popover>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const windowApi = getElectronWindowApi();
    if (!windowApi) return;
    void refreshMaximizedState(setMaximized);
    return windowApi.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="flex h-full items-center">
      <WindowButton label="最小化" onClick={() => void runWindowAction((w) => w.minimize())}>
        <Minus className="size-4" />
      </WindowButton>
      <WindowButton
        label={maximized ? "还原" : "最大化"}
        onClick={() =>
          void runWindowAction(async (w) => {
            await w.toggleMaximize();
            await refreshMaximizedState(setMaximized);
          })
        }
      >
        {maximized ? <CopyMinus className="size-4" /> : <SquareIcon className="size-4" />}
      </WindowButton>
      <WindowButton label="退出" close onClick={() => void runWindowAction((w) => w.close())}>
        <X className="size-4" />
      </WindowButton>
    </div>
  );
}

function WindowButton({
  children,
  close,
  label,
  onClick,
}: {
  children: ReactNode;
  close?: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      className={cn(
        "flex h-full w-11 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        close && "hover:bg-destructive hover:text-white",
      )}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
      <span className="sr-only">{label}</span>
    </button>
  );
}
