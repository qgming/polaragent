import {
  Archive,
  BarChart3,
  GitBranch,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/renderer/components/ui/dropdown-menu";
import { Input } from "@/renderer/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { formatRelativeDay } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { SessionSummary } from "@/shared/contracts/session";

type DayGroup = "today" | "yesterday" | "earlier";

// 日期分组的展示顺序与词条 key
const GROUP_ORDER: readonly DayGroup[] = ["today", "yesterday", "earlier"];
const GROUP_LABEL_KEYS: Record<
  DayGroup,
  "sidebar.today" | "sidebar.yesterday" | "sidebar.earlier"
> = {
  today: "sidebar.today",
  yesterday: "sidebar.yesterday",
  earlier: "sidebar.earlier",
};

// format 车道返回的是显示文案（「今天」/「昨天」/「M月D日」），据此映射到分组枚举
function toDayGroup(label: string): DayGroup {
  if (label === "今天") return "today";
  if (label === "昨天") return "yesterday";
  return "earlier";
}

interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  onSelect: () => void;
  onRename: () => void;
  onArchive: () => void;
  onRemove: () => void;
}

/** 单条会话：当前项品牌浅底 + 左竖条；fork 子项缩进 + 分支符；hover 出 ··· 菜单 */
function SessionItem({
  session,
  active,
  running,
  onSelect,
  onRename,
  onArchive,
  onRemove,
}: SessionItemProps) {
  const { t } = useTranslation();
  const isFork = Boolean(session.parentSessionId);

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md text-sm transition-colors",
          isFork ? "pl-8" : "pl-3",
          active
            ? "bg-brand-muted text-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent",
        )}
      >
        {/* 当前项左侧 2px 品牌竖条（E2 落点 ③） */}
        {active && (
          <span className="absolute top-1 bottom-1 left-0 w-0.5 bg-brand" aria-hidden="true" />
        )}
        {isFork && (
          <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate text-left">
          {session.title ?? t("chat.newChat")}
        </span>
        {/* 运行中：品牌脉冲点（E2 落点 ④） */}
        {running && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-brand animate-pulse"
            aria-hidden="true"
          />
        )}
      </button>

      {/* hover 或键盘聚焦时显示 ··· 菜单 */}
      <div className="absolute top-0 right-1 bottom-0 flex items-center opacity-0 transition-opacity pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-xs" aria-label={t("common.more")}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              {t("sidebar.rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onArchive}>
              <Archive />
              {session.archived ? t("sidebar.unarchive") : t("sidebar.archive")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              <Trash2 />
              {t("sidebar.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

export function SidebarShell() {
  const { t } = useTranslation();

  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const openSettings = useUiStore((s) => s.openSettings);

  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const runningBySession = useChatStore((s) => s.runningBySession);
  const { createSession, setActiveSession, renameSession, archiveSession, removeSession } =
    useChatStore.getState();

  const [filter, setFilter] = useState("");
  // 重命名与删除确认对话框的目标会话（null = 关闭）
  const [renaming, setRenaming] = useState<SessionSummary | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<SessionSummary | null>(null);

  // 本地标题过滤 + 按相对日期分组（今天 / 昨天 / 更早）
  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q ? sessions.filter((s) => s.title?.toLowerCase().includes(q)) : sessions;
    const buckets: Record<DayGroup, SessionSummary[]> = {
      today: [],
      yesterday: [],
      earlier: [],
    };
    for (const s of filtered) {
      buckets[toDayGroup(formatRelativeDay(s.updatedAt))].push(s);
    }
    return GROUP_ORDER.map((key) => ({ key, items: buckets[key] })).filter(
      (g) => g.items.length > 0,
    );
  }, [sessions, filter]);

  const openRename = (session: SessionSummary) => {
    setRenameTitle(session.title ?? "");
    setRenaming(session);
  };

  const confirmRename = () => {
    const title = renameTitle.trim();
    if (renaming && title) void renameSession(renaming.id, title);
    setRenaming(null);
  };

  const confirmRemoveSession = () => {
    if (confirmRemove) void removeSession(confirmRemove.id);
    setConfirmRemove(null);
  };

  // 折叠开关：展开/收起切换提示词条
  const collapseToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
          onClick={toggleSidebar}
        >
          <PanelLeft className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {collapsed ? t("app.expandSidebar") : t("app.collapseSidebar")}
      </TooltipContent>
    </Tooltip>
  );

  return (
    <aside
      className={cn(
        "flex shrink-0 flex-col border-border border-r bg-sidebar transition-[width] duration-200",
        collapsed ? "w-12" : "w-60",
      )}
    >
      {collapsed ? (
        /* 折叠态：48px 图标轨道，hover 出 tooltip */
        <div className="flex flex-col items-center gap-1 p-2">
          {collapseToggle}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("sidebar.newChat")}
                onClick={() => void createSession()}
              >
                <Plus className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("sidebar.newChat")}</TooltipContent>
          </Tooltip>
        </div>
      ) : (
        /* 展开态：折叠开关 + 新对话 + 筛选 */
        <div className="flex flex-col gap-1 p-2">
          <div className="flex items-center gap-1">
            {collapseToggle}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 flex-1 justify-start gap-1.5"
              onClick={() => void createSession()}
            >
              <Plus className="size-4" />
              {t("sidebar.newChat")}
            </Button>
          </div>
          <div className="relative">
            <Search
              className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t("sidebar.filterSessions")}
              aria-label={t("sidebar.filterSessions")}
              className="h-8 border-transparent bg-muted pl-8"
            />
          </div>
        </div>
      )}

      {/* 会话列表：按日期分组；折叠时隐藏 */}
      {!collapsed && (
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {groups.length === 0 ? (
            <p className="px-3 py-2 text-sm text-muted-foreground">{t("common.empty")}</p>
          ) : (
            groups.map((group) => (
              <div key={group.key} className="mb-1">
                {/* 组标题：mono 11px 眉题，保持安静 */}
                <p className="px-3 py-1 font-mono text-[11px] tracking-wide text-muted-foreground">
                  {t(GROUP_LABEL_KEYS[group.key])}
                </p>
                {group.items.map((session) => (
                  <SessionItem
                    key={session.id}
                    session={session}
                    active={session.id === activeSessionId}
                    running={Boolean(runningBySession[session.id])}
                    onSelect={() => void setActiveSession(session.id)}
                    onRename={() => openRename(session)}
                    onArchive={() => void archiveSession(session.id, !session.archived)}
                    onRemove={() => setConfirmRemove(session)}
                  />
                ))}
              </div>
            ))
          )}
        </div>
      )}

      {/* 底部：设置（左）+ 用量（右，占位） */}
      <div
        className={cn(
          "border-border border-t p-2",
          collapsed && "flex flex-col items-center gap-1",
        )}
      >
        <div className={cn(!collapsed && "flex items-center justify-between")}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("sidebar.settings")}
                onClick={() => openSettings()}
              >
                <Settings2 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("sidebar.settings")}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t("sidebar.usage")}
                onClick={() => {
                  // TODO(feature)：用量 popover 后续 checkpoint 接入
                }}
              >
                <BarChart3 className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">{t("sidebar.usage")}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 重命名对话框：输入新标题，Enter 或「保存」确认 */}
      <Dialog open={renaming !== null} onOpenChange={(open) => !open && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("sidebar.rename")}</DialogTitle>
            <DialogDescription className="sr-only">{t("sidebar.rename")}</DialogDescription>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(e) => setRenameTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && confirmRename()}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" onClick={confirmRename}>
              {t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除二次确认（设计稿 D1：删除类操作一律走确认） */}
      <Dialog
        open={confirmRemove !== null}
        onOpenChange={(open) => !open && setConfirmRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("common.delete")}</DialogTitle>
            <DialogDescription>「{confirmRemove?.title ?? ""}」</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirmRemove(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" variant="destructive" onClick={confirmRemoveSession}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
