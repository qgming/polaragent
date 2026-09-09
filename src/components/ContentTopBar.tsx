// 内容区顶栏：折叠按钮 + 页面标题 + 功能按钮 + 窗口控制
// src/components/ContentTopBar.tsx

import {
  BarChart3,
  CopyMinus,
  Minus,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Square as SquareIcon,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

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
import { useConfigStore } from "@/stores/config-store";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { cn } from "@/lib/utils";

export function ContentTopBar({
  title,
  onOpenSearch,
  onToggleSidebar,
  showPanelToggle,
  sidebarCollapsed,
  statsThreadId,
}: {
  title: string;
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  showPanelToggle: boolean;
  sidebarCollapsed: boolean;
  statsThreadId?: string;
}) {
  const { t } = useTranslation();

  return (
    <header
      data-electron-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-border/40 bg-white pl-1 dark:bg-background"
    >
      <div className="flex h-full min-w-0 items-center px-2">
        <button
          type="button"
          onClick={onToggleSidebar}
          title={t("nav:titleBar.openSidebar")}
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
        <IconButton
          className="size-8"
          label={t("nav:titleBar.searchSessions")}
          onClick={onOpenSearch}
        >
          <Search className="size-4" />
        </IconButton>
        {showPanelToggle ? (
          <>
            <SessionStatsButton threadId={statsThreadId} />
            <PanelToggleButton />
          </>
        ) : null}
        <div className="mx-1.5 h-4 w-px bg-border" />
        <WindowControls />
      </div>
    </header>
  );
}

function SessionStatsButton({ threadId }: { threadId?: string }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
          title={t("nav:titleBar.sessionStats")}
          type="button"
        >
          <BarChart3 className="size-4" />
          <span className="sr-only">{t("nav:titleBar.sessionStats")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="bottom" sideOffset={6} className="w-80 p-0">
        <SessionStatsPopover threadId={threadId} />
      </PopoverContent>
    </Popover>
  );
}

function PanelToggleButton() {
  const { t } = useTranslation();
  const panelOpen = usePanelOpen();
  const toggle = usePanelStore((state) => state.toggle);

  return (
    <IconButton
      className="size-8"
      label={panelOpen ? t("nav:titleBar.collapsePanel") : t("nav:titleBar.expandPanel")}
      onClick={toggle}
    >
      {panelOpen ? (
        <PanelRightClose className="size-4" />
      ) : (
        <PanelRightOpen className="size-4" />
      )}
    </IconButton>
  );
}

function WindowControls() {
  const { t } = useTranslation();
  const [maximized, setMaximized] = useState(false);
  const closeToTray = useConfigStore((state) => state.settings.window.closeToTray);

  useEffect(() => {
    const windowApi = getElectronWindowApi();
    if (!windowApi) return;
    void refreshMaximizedState(setMaximized);
    return windowApi.onMaximizedChange(setMaximized);
  }, []);

  return (
    <div className="flex h-full items-center">
      <WindowButton label={t("common:minimize")} onClick={() => void runWindowAction((w) => w.minimize())}>
        <Minus className="size-4" />
      </WindowButton>
      <WindowButton
        label={maximized ? t("common:restore") : t("common:maximize")}
        onClick={() =>
          void runWindowAction(async (w) => {
            await w.toggleMaximize();
            await refreshMaximizedState(setMaximized);
          })
        }
      >
        {maximized ? <CopyMinus className="size-4" /> : <SquareIcon className="size-4" />}
      </WindowButton>
      <WindowButton
        close
        label={closeToTray ? t("common:close") : t("common:exit")}
        onClick={() => void runWindowAction((w) => w.close())}
      >
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
