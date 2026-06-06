// 顶部标题栏与窗口控制按钮
// src/components/TitleBar.tsx

import {
  CopyMinus,
  Info,
  Menu,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  Search,
  Square as SquareIcon,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { IconButton } from "@/components/IconButton";
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
  getElectronWindowApi,
  refreshMaximizedState,
  runWindowAction,
} from "@/lib/electron/electron-window";
import { useConfigStore } from "@/stores/config-store";
import { usePanelOpen, usePanelStore } from "@/stores/panel-store";
import { useTeamPanelStore } from "@/stores/team/team-panel-store";
import { cn } from "@/lib/utils";

export function TitleBar({
  onOpenAbout,
  onOpenSearch,
  onToggleSidebar,
  showPanelToggle,
  sidebarCollapsed,
  teamPanelThreadId,
}: {
  onOpenAbout: () => void;
  onOpenSearch: () => void;
  onToggleSidebar: () => void;
  showPanelToggle: boolean;
  sidebarCollapsed: boolean;
  teamPanelThreadId?: string;
}) {
  return (
    <header
      data-electron-drag-region
      className="flex h-11 shrink-0 items-center justify-between border-b border-border bg-background"
    >
      <div className="flex h-full items-center gap-1 px-2">
        <AppMenu onOpenAbout={onOpenAbout} />
        <IconButton
          className="size-8"
          label={sidebarCollapsed ? "打开侧边栏" : "关闭侧边栏"}
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
          label="搜索会话"
          onClick={onOpenSearch}
        >
          <Search className="size-4" />
        </IconButton>
      </div>

      <div className="flex h-full items-center">
        {showPanelToggle ? (
          <>
            <PanelToggleButton teamThreadId={teamPanelThreadId} />
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
  const settings = useConfigStore((state) => state.settings);
  const updateSettings = useConfigStore((state) => state.updateSettings);

  const setTheme = (theme: typeof settings.appearance.theme) => {
    void updateSettings({
      appearance: {
        ...settings.appearance,
        theme,
      },
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex size-8 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/35"
          title="主菜单"
          type="button"
        >
          <Menu className="size-4" />
          <span className="sr-only">主菜单</span>
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
            主题设置
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
                亮色
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark" className="rounded-md px-2 py-1.5">
                深色
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system" className="rounded-md px-2 py-1.5">
                跟随系统
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem
          className="rounded-md px-2 py-1.5"
          onSelect={onOpenAbout}
        >
          <Info className="size-4" />
          关于软件
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// 顶部栏右侧：任务监控面板开合按钮（状态来自 panel-store，与对话页共享）
function PanelToggleButton({ teamThreadId }: { teamThreadId?: string }) {
  if (teamThreadId) {
    return <TeamPanelToggleButton threadId={teamThreadId} />;
  }

  return <ChatPanelToggleButton />;
}

function ChatPanelToggleButton() {
  const panelOpen = usePanelOpen();
  const toggle = usePanelStore((state) => state.toggle);

  return (
    <IconButton
      className="size-8"
      label={panelOpen ? "收起监控面板" : "展开监控面板"}
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

function TeamPanelToggleButton({ threadId }: { threadId: string }) {
  const panelOpen = useTeamPanelStore(
    (state) => state.openByThread[threadId] ?? false,
  );
  const toggle = useTeamPanelStore((state) => state.togglePanel);

  return (
    <IconButton
      className="size-8"
      label={panelOpen ? "收起团队监控面板" : "展开团队监控面板"}
      onClick={() => toggle(threadId)}
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
  const [maximized, setMaximized] = useState(false);

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
      <WindowButton label="最小化" onClick={minimize}>
        <Minus className="size-4" />
      </WindowButton>
      <WindowButton
        label={maximized ? "还原" : "最大化"}
        onClick={toggleMaximize}
      >
        {maximized ? (
          <CopyMinus className="size-4" />
        ) : (
          <SquareIcon className="size-4" />
        )}
      </WindowButton>
      <WindowButton close label="退出" onClick={close}>
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
