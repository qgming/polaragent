// 顶部标题栏与窗口控制按钮
// src/components/TitleBar.tsx

import {
  BadgeHelp,
  BarChart3,
  CopyMinus,
  Info,
  Menu,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  RefreshCw,
  Search,
  Square as SquareIcon,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/IconButton";
import { SessionStatsPopover } from "@/components/chat/SessionStatsPopover";
import { UpdateNotesModal } from "@/components/updates/UpdateNotesModal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/useToast";
import {
  checkForUpdates,
  isElectronRuntime,
} from "@/lib/electron/electron-api";
import {
  getElectronWindowApi,
  refreshMaximizedState,
  runWindowAction,
} from "@/lib/electron/electron-window";
import { useConfigStore } from "@/stores/config-store";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { cn } from "@/lib/utils";

export function TitleBar({
  onOpenAbout,
  onOpenSearch,
  onOpenTutorial,
  onToggleSidebar,
  showPanelToggle,
  sidebarCollapsed,
  statsThreadId,
}: {
  onOpenAbout: () => void;
  onOpenSearch: () => void;
  onOpenTutorial: () => void;
  onToggleSidebar: () => void;
  showPanelToggle: boolean;
  sidebarCollapsed: boolean;
  statsThreadId?: string;
}) {
  const { t } = useTranslation();

  return (
    <header
      data-electron-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-background"
    >
      <div className="flex h-full items-center gap-1 px-2">
        <AppMenu onOpenAbout={onOpenAbout} />
        <IconButton
          className="size-8"
          label={sidebarCollapsed ? t("nav:titleBar.openSidebar") : t("nav:titleBar.closeSidebar")}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <PanelLeftClose className="size-4" />
          )}
        </IconButton>
        <IconButton
          className="size-8"
          label={t("nav:titleBar.searchSessions")}
          onClick={onOpenSearch}
        >
          <Search className="size-4" />
        </IconButton>
        <IconButton
          className="size-8"
          label={t("nav:titleBar.tutorial")}
          onClick={onOpenTutorial}
        >
          <BadgeHelp className="size-4" />
        </IconButton>
      </div>

      <div className="flex h-full items-center">
        {showPanelToggle ? (
          <>
            <SessionStatsButton threadId={statsThreadId} />
            <PanelToggleButton />
            {/* 与窗口控制按钮之间的小竖分割线 */}
            <div className="mx-1 h-5 w-px bg-border" />
          </>
        ) : null}
        <WindowControls />
      </div>
    </header>
  );
}

function AppMenu({ onOpenAbout }: { onOpenAbout: () => void }) {
  const { t } = useTranslation();
  const settings = useConfigStore((state) => state.settings);
  const updateSettings = useConfigStore((state) => state.updateSettings);
  const toastSuccess = useToast((state) => state.success);
  const toastError = useToast((state) => state.error);
  const [updateModalOpen, setUpdateModalOpen] = useState(false);
  const [checking, setChecking] = useState(false);

  const setTheme = (theme: typeof settings.appearance.theme) => {
    void updateSettings({
      appearance: {
        ...settings.appearance,
        theme,
      },
    });
  };

  async function handleCheckUpdates() {
    if (!isElectronRuntime()) return;

    setChecking(true);
    try {
      const status = await checkForUpdates();
      if (status.phase === "up-to-date") {
        toastSuccess(t("settings:about.upToDate"));
        return;
      }
      if (status.updateAvailable) {
        setUpdateModalOpen(true);
        return;
      }
      if (status.phase === "check-error") {
        toastError(status.error || t("settings:about.checkFailed"));
        return;
      }
      toastError(status.message || t("settings:about.noUpdate"));
    } catch (error) {
      toastError(error instanceof Error ? error.message : String(error));
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
            title={t("nav:titleBar.menu")}
            type="button"
          >
            <Menu className="size-4" />
            <span className="sr-only">{t("nav:titleBar.menu")}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-48 space-y-1 rounded-lg p-1"
          sideOffset={8}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              hideChevron
              className="rounded-md px-2 py-1.5"
            >
              <Palette className="size-4" />
              {t("nav:titleBar.theme")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent
              alignOffset={-2}
              className="w-40 rounded-lg p-1"
              sideOffset={10}
            >
              <DropdownMenuRadioGroup
                className="space-y-1"
                value={settings.appearance.theme}
                onValueChange={(theme) =>
                  setTheme(theme as typeof settings.appearance.theme)
                }
              >
                <DropdownMenuRadioItem value="light" className="rounded-md px-2 py-1.5">
                  {t("nav:titleBar.light")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark" className="rounded-md px-2 py-1.5">
                  {t("nav:titleBar.dark")}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="system" className="rounded-md px-2 py-1.5">
                  {t("nav:titleBar.followSystem")}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem
            className="rounded-md px-2 py-1.5"
            onSelect={() => void handleCheckUpdates()}
            disabled={checking}
          >
            <RefreshCw className={checking ? "size-4 animate-spin" : "size-4"} />
            {checking ? t("nav:titleBar.checking") : t("nav:titleBar.checkUpdate")}
          </DropdownMenuItem>
          <DropdownMenuItem
            className="rounded-md px-2 py-1.5"
            onSelect={onOpenAbout}
          >
            <Info className="size-4" />
            {t("nav:titleBar.about")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <UpdateNotesModal
        open={updateModalOpen}
        onOpenChange={setUpdateModalOpen}
        checkOnOpenKey={0}
      />
    </>
  );
}

// 顶部栏右侧：会话用量统计按钮
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

// 顶部栏右侧：任务监控面板开合按钮（状态来自 panel-store，与对话页共享）
function PanelToggleButton() {
  return <ChatPanelToggleButton />;
}

function ChatPanelToggleButton() {
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
    if (!windowApi) {
      return;
    }

    void refreshMaximizedState(setMaximized);
    return windowApi.onMaximizedChange(setMaximized);
  }, []);

  const minimize = () => {
    void runWindowAction((appWindow) => appWindow.minimize());
  };

  const toggleMaximize = () => {
    void runWindowAction(async (appWindow) => {
      await appWindow.toggleMaximize();
      await refreshMaximizedState(setMaximized);
    });
  };

  const close = () => {
    void runWindowAction((appWindow) => appWindow.close());
  };

  return (
    <div className="flex h-full items-center">
      <WindowButton label={t("common:minimize")} onClick={minimize}>
        <Minus className="size-4" />
      </WindowButton>
      <WindowButton
        label={maximized ? t("common:restore") : t("common:maximize")}
        onClick={toggleMaximize}
      >
        {maximized ? (
          <CopyMinus className="size-4" />
        ) : (
          <SquareIcon className="size-4" />
        )}
      </WindowButton>
      <WindowButton close label={closeToTray ? t("common:close") : t("common:exit")} onClick={close}>
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
