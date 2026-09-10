import { ArrowDown, ArrowUp, CornerDownLeft, MessageSquare, Search, Settings } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { ScrollArea } from "@/renderer/components/ui/scroll-area";
import { formatRelativeDay, formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { type SettingsSection, useUiStore } from "@/renderer/stores/ui-store";
import { escapeRegExp, findMatches } from "./find-matches";

/** 输入即搜的防抖时长 */
const DEBOUNCE_MS = 150;
/** 消息结果上限，避免长会话刷屏 */
const MESSAGE_LIMIT = 20;
/** 空输入时展示的最近会话数 */
const RECENT_SESSION_LIMIT = 5;

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "services",
  "permissions",
  "skills",
  "personalization",
  "about",
];

type CommandId = "new-chat" | "toggle-theme";

interface SessionEntry {
  kind: "session";
  key: string;
  sessionId: string;
  title: string;
  meta: string;
  /** fork 子会话：父会话标注 */
  parentLabel?: string;
}

interface MessageEntry {
  kind: "message";
  key: string;
  sessionId: string;
  snippet: string;
  keyword: string;
  location: string;
}

interface SettingEntry {
  kind: "setting";
  key: string;
  section: SettingsSection;
  label: string;
  actionLabel: string;
}

interface CommandEntry {
  kind: "command";
  key: string;
  command: CommandId;
  label: string;
  hint?: string;
}

type SearchEntry = SessionEntry | MessageEntry | SettingEntry | CommandEntry;

interface SearchGroup {
  key: string;
  label: string;
  entries: SearchEntry[];
}

/** 把命中片段渲染为节点：关键词用品牌浅底标注，不改变字重 */
function renderHighlighted(text: string, keyword: string): ReactNode[] {
  if (!keyword) return [text];
  const pattern = new RegExp(escapeRegExp(keyword), "gi");
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      nodes.push(<span key={`text-${cursor}`}>{text.slice(cursor, start)}</span>);
    }
    nodes.push(
      <mark key={`hit-${start}`} className="rounded-[2px] bg-brand-muted text-inherit">
        {match[0]}
      </mark>,
    );
    cursor = start + match[0].length;
  }
  if (cursor < text.length) {
    nodes.push(<span key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  }
  return nodes;
}

/** 结果行内容：按类型给出不同的信息层级 */
function renderEntryContent(entry: SearchEntry): ReactNode {
  switch (entry.kind) {
    case "session":
      return (
        <>
          <span className="min-w-0 flex-1 truncate text-sm">
            {entry.parentLabel ? (
              <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">
                {entry.parentLabel}
              </span>
            ) : null}
            {entry.title}
          </span>
          <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
            {entry.meta}
          </span>
        </>
      );
    case "message":
      return (
        <>
          <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px]">
              {renderHighlighted(entry.snippet, entry.keyword)}
            </span>
            <span className="mt-0.5 block font-mono text-[11px] text-muted-foreground">
              {entry.location}
            </span>
          </span>
        </>
      );
    case "setting":
      return (
        <>
          <Settings className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
          <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
            {entry.actionLabel}
          </span>
        </>
      );
    case "command":
      return (
        <>
          <CornerDownLeft className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-sm">{entry.label}</span>
          {entry.hint ? (
            <span className="shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
              {entry.hint}
            </span>
          ) : null}
        </>
      );
  }
}

/**
 * 全局搜索面板（B7 · Ctrl+K）：输入即搜，结果按 会话 → 消息 → 设置 → 命令 分组。
 * 会话与消息来自本地 store（只搜已加载会话），设置与命令为固定项，无需新 IPC。
 * 打开/关闭与遮罩由 ui-store + Dialog 控制；全局快捷键监听由 App 统一挂载。
 */
export function GlobalSearch() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.globalSearchOpen);
  const closeGlobalSearch = useUiStore((s) => s.closeGlobalSearch);
  const openSettings = useUiStore((s) => s.openSettings);
  const openSessionSearch = useUiStore((s) => s.openSessionSearch);
  const setSessionSearchQuery = useUiStore((s) => s.setSessionSearchQuery);
  const sessions = useChatStore((s) => s.sessions);
  const messagesBySession = useChatStore((s) => s.messagesBySession);
  const runningBySession = useChatStore((s) => s.runningBySession);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const createSession = useChatStore((s) => s.createSession);
  const theme = useSettingsStore((s) => s.settings?.theme);
  const updateSettings = useSettingsStore((s) => s.update);

  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // 输入即搜：150ms 防抖，关闭或卸载时清理定时器
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  // 关闭时清空输入与选中项，下次打开从干净状态开始
  useEffect(() => {
    if (open) return;
    setQuery("");
    setDebouncedQuery("");
    setActiveIndex(0);
  }, [open]);

  const keyword = debouncedQuery.trim();

  const groups = useMemo<SearchGroup[]>(() => {
    const lowered = keyword.toLocaleLowerCase();
    const titleById = new Map(sessions.map((s) => [s.id, s.title ?? t("chat.newChat")]));

    // 会话：按标题匹配；输入为空时退化为最近会话
    const sessionEntries: SessionEntry[] = [];
    for (const session of sessions) {
      const title = session.title ?? t("chat.newChat");
      if (lowered && !title.toLocaleLowerCase().includes(lowered)) continue;
      const parent = session.parentSessionId
        ? sessions.find((s) => s.id === session.parentSessionId)
        : undefined;
      const metaParts = [
        `${formatRelativeDay(session.updatedAt)} ${formatTime(session.updatedAt)}`,
        t("search.sessionMessages", {
          defaultValue: "{{count}} 条消息",
          count: session.messageCount,
        }),
      ];
      if (runningBySession[session.id]) metaParts.push(t("chat.running"));
      sessionEntries.push({
        kind: "session",
        key: `session:${session.id}`,
        sessionId: session.id,
        title,
        meta: metaParts.join(" · "),
        ...(parent
          ? { parentLabel: `${t("sidebar.branchOf")} · ${parent.title ?? t("chat.newChat")}` }
          : {}),
      });
      if (!lowered && sessionEntries.length >= RECENT_SESSION_LIMIT) break;
    }

    // 消息：只遍历已加载的会话；每条命中消息生成一行结果
    const messageEntries: MessageEntry[] = [];
    if (lowered) {
      // 先按会话列表（updatedAt 降序）遍历，保证结果顺序稳定
      const loadedIds = Object.keys(messagesBySession);
      const orderedIds = [
        ...sessions.map((s) => s.id).filter((id) => loadedIds.includes(id)),
        ...loadedIds.filter((id) => !sessions.some((s) => s.id === id)),
      ];
      for (const sessionId of orderedIds) {
        if (messageEntries.length >= MESSAGE_LIMIT) break;
        const messages = messagesBySession[sessionId];
        if (!messages) continue;
        for (const match of findMatches(messages, keyword)) {
          if (messageEntries.length >= MESSAGE_LIMIT) break;
          const sessionTitle = titleById.get(sessionId) ?? t("chat.newChat");
          messageEntries.push({
            kind: "message",
            key: `message:${sessionId}:${match.messageId}`,
            sessionId,
            snippet: match.snippet,
            keyword,
            location: `${t("search.messageIn", {
              defaultValue: "在「{{title}}」",
              title: sessionTitle,
            })} · ${t("search.hitCount", { defaultValue: "命中 {{count}} 处", count: match.count })}`,
          });
        }
      }
    }

    // 设置：固定六个分类，按当前语言标签过滤
    const settingEntries: SettingEntry[] = SETTINGS_SECTIONS.map((section) => ({
      section,
      label: t(`settings.${section}`),
    }))
      .filter(({ label }) => !lowered || label.toLocaleLowerCase().includes(lowered))
      .map(({ section, label }) => ({
        kind: "setting" as const,
        key: `setting:${section}`,
        section,
        label,
        actionLabel: `${t("search.openSettings", { defaultValue: "打开设置" })} → ${label}`,
      }));

    // 命令：新建对话 + 切换主题（显示将要切到的主题）
    const nextThemeLabel = t(theme === "dark" ? "app.themeLight" : "app.themeDark");
    const commands: CommandEntry[] = [
      {
        kind: "command",
        key: "command:new-chat",
        command: "new-chat",
        label: t("chat.newChat"),
        hint: "Ctrl+N",
      },
      {
        kind: "command",
        key: "command:toggle-theme",
        command: "toggle-theme",
        label: t("search.toggleTheme", {
          defaultValue: "切换主题（{{theme}}）",
          theme: nextThemeLabel,
        }),
      },
    ];
    const commandEntries = commands.filter(
      (entry) => !lowered || entry.label.toLocaleLowerCase().includes(lowered),
    );

    return [
      {
        key: "sessions",
        label: t("search.groupSessions", { defaultValue: "会话" }),
        entries: sessionEntries,
      },
      {
        key: "messages",
        label: t("search.groupMessages", { defaultValue: "消息" }),
        entries: messageEntries,
      },
      {
        key: "settings",
        label: t("search.groupSettings", { defaultValue: "设置" }),
        entries: settingEntries,
      },
      {
        key: "commands",
        label: t("search.groupCommands", { defaultValue: "命令" }),
        entries: commandEntries,
      },
    ].filter((group) => group.entries.length > 0);
  }, [keyword, sessions, messagesBySession, runningBySession, theme, t]);

  const entries = useMemo(() => groups.flatMap((group) => group.entries), [groups]);
  const safeIndex = entries.length === 0 ? 0 : Math.min(activeIndex, entries.length - 1);
  const activeEntry = entries[safeIndex];

  // 关键词变化后回到首条结果
  const lastKeywordRef = useRef(keyword);
  useEffect(() => {
    if (lastKeywordRef.current === keyword) return;
    lastKeywordRef.current = keyword;
    setActiveIndex(0);
  }, [keyword]);

  const move = (delta: number) => {
    setActiveIndex((prev) => {
      if (entries.length === 0) return 0;
      const current = Math.min(prev, entries.length - 1);
      return (current + delta + entries.length) % entries.length;
    });
  };

  /** Enter / 点击：按结果类型执行动作 */
  const execute = (entry: SearchEntry) => {
    switch (entry.kind) {
      case "session":
        void setActiveSession(entry.sessionId);
        closeGlobalSearch();
        break;
      case "message":
        // 打开会话并带着关键词进入会话内搜索；滚动定位由 Thread 车道负责
        void setActiveSession(entry.sessionId);
        closeGlobalSearch();
        setSessionSearchQuery(entry.keyword);
        openSessionSearch();
        break;
      case "setting":
        closeGlobalSearch();
        openSettings(entry.section);
        break;
      case "command": {
        if (entry.command === "new-chat") {
          void createSession();
        } else {
          void updateSettings({ theme: theme === "dark" ? "light" : "dark" });
        }
        closeGlobalSearch();
        break;
      }
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 中文输入法组合期间不响应快捷键
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter": {
        // 焦点在结果行按钮上时交给按钮自身的点击，避免重复执行
        if (event.target instanceof HTMLButtonElement) return;
        if (!activeEntry) return;
        event.preventDefault();
        execute(activeEntry);
        break;
      }
      case "Escape":
        event.preventDefault();
        closeGlobalSearch();
        break;
      case "Tab": {
        // Tab / Shift+Tab 在非空分组之间跳转，选中目标组的第一条
        if (groups.length <= 1) return;
        event.preventDefault();
        // 阻止 Radix 焦点圈把焦点移到结果行，保持输入框聚焦
        event.stopPropagation();
        const currentGroupIndex = activeEntry
          ? groups.findIndex((group) => group.entries.includes(activeEntry))
          : -1;
        const delta = event.shiftKey ? -1 : 1;
        const nextGroup = groups[(currentGroupIndex + delta + groups.length) % groups.length];
        const firstEntry = nextGroup?.entries[0];
        if (!firstEntry) return;
        setActiveIndex(entries.indexOf(firstEntry));
        break;
      }
      default:
        break;
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeGlobalSearch();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="bg-foreground/20 motion-reduce:animate-none" />
        <DialogPrimitive.Content
          aria-label={t("search.globalTitle", { defaultValue: "全局搜索" })}
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={(event) => {
            // 面板打开后焦点直接落在输入框，避免先聚焦结果行
            event.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            "fixed top-[12vh] left-1/2 z-50 flex w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground outline-none",
            "duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 motion-reduce:animate-none",
          )}
        >
          <DialogTitle className="sr-only">
            {t("search.globalTitle", { defaultValue: "全局搜索" })}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("search.globalDesc", { defaultValue: "搜索会话、消息、设置或命令" })}
          </DialogDescription>

          <div className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
            <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("search.globalPlaceholder", {
                defaultValue: "搜索会话、消息、设置或命令…",
              })}
              aria-label={t("common.search")}
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
              Esc {t("search.hintClose", { defaultValue: "关闭" })}
            </span>
          </div>

          {entries.length > 0 ? (
            <ScrollArea className="max-h-[420px] [&_[data-slot='scroll-area-viewport']]:max-h-[420px]">
              <div className="py-1">
                {groups.map((group) => (
                  <div key={group.key}>
                    <div className="px-4 pt-2 pb-1 font-mono text-[11px] text-muted-foreground tracking-[0.04em]">
                      {group.label}
                    </div>
                    {group.entries.map((entry) => {
                      const index = entries.indexOf(entry);
                      return (
                        <button
                          key={entry.key}
                          type="button"
                          className={cn(
                            "flex w-full items-start gap-3 px-4 py-2 text-left",
                            index === safeIndex
                              ? "bg-accent text-accent-foreground"
                              : "hover:bg-muted",
                          )}
                          onMouseMove={() => setActiveIndex(index)}
                          onClick={() => execute(entry)}
                        >
                          {renderEntryContent(entry)}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              {t("search.noResults", { defaultValue: "没有找到，检查拼写或换个说法" })}
            </div>
          )}

          <div className="flex h-10 shrink-0 items-center justify-between border-border border-t px-4 font-mono text-[11px] text-muted-foreground">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1">
                <ArrowUp className="size-3" aria-hidden />
                <ArrowDown className="size-3" aria-hidden />
                {t("search.hintSelect", { defaultValue: "选择" })}
              </span>
              <span className="flex items-center gap-1">
                <CornerDownLeft className="size-3" aria-hidden />
                {t("search.hintOpen", { defaultValue: "打开" })}
              </span>
              <span>Tab {t("search.hintCategories", { defaultValue: "切换分类" })}</span>
              <span>Esc {t("search.hintClose", { defaultValue: "关闭" })}</span>
            </div>
            <span className="tabular-nums">
              {t("search.resultCount", {
                defaultValue: "共 {{count}} 个结果",
                count: entries.length,
              })}
            </span>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
