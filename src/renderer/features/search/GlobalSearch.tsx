import { Dialog as DialogPrimitive } from "radix-ui";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CommandPalette,
  type PaletteCommand,
} from "@/renderer/components/assistant-ui/elements/command-palette";
import {
  Dialog,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { formatRelativeDay, formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { type SettingsSection, useUiStore } from "@/renderer/stores/ui-store";
import { findMatches } from "./find-matches";

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

/**
 * 全局搜索面板（Ctrl+K）：输入即搜，结果按 会话 → 消息 → 设置 → 命令 分组。
 *
 * 结果列表交给官方 CommandPalette 渲染（分组眉题、键盘上下、Enter、Esc 标记都由它提供），
 * 本组件只负责把四类结果映射成它的 PaletteCommand：
 *   label 是主文案，keys 是右侧那一串等宽标记（会话的更新时间、命中的位置、设置的去向、命令的快捷键）。
 * 官方组件按 label 自行过滤，因此这里仍按各自规则先筛好（消息要按正文命中而不是标题）。
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

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [activeId, setActiveId] = useState("");

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
    setActiveId("");
  }, [open]);

  const keyword = debouncedQuery.trim();

  /**
   * 结果动作表：官方 palette 只回传 id，动作在这里按 id 查表执行
   */
  const actions = useRef(new Map<string, () => void>());

  /**
   * 预筛谓词必须与官方 palette 内部那条 `label.includes(query)` 完全一致：
   * palette 会用**未 trim 的 query** 再筛一次，这里若用 trim 后的 keyword，
   * 输入前导/尾随空格就会出现「先显示、再整片消失」。
   * 因此统一用未 trim 的 query 做谓词；只有「要不要扫消息正文」这个开关用 keyword 判断。
   */
  const lowered = debouncedQuery.toLocaleLowerCase();
  const hasQuery = keyword.length > 0;

  const commands = useMemo<PaletteCommand[]>(() => {
    const next = new Map<string, () => void>();
    const out: PaletteCommand[] = [];

    const groupSessions = t("search.groupSessions");
    const groupMessages = t("search.groupMessages");
    const groupSettings = t("search.groupSettings");
    const groupCommands = t("search.groupCommands");

    // 会话：按标题匹配；输入为空时退化为最近会话
    let sessionCount = 0;
    const titleById = new Map(sessions.map((s) => [s.id, s.title ?? t("chat.newChat")]));
    for (const session of sessions) {
      const title = session.title ?? t("chat.newChat");
      if (!title.toLocaleLowerCase().includes(lowered)) continue;
      const parent = session.parentSessionId
        ? sessions.find((s) => s.id === session.parentSessionId)
        : undefined;
      const metaParts = [
        `${formatRelativeDay(session.updatedAt)} ${formatTime(session.updatedAt)}`,
        t("search.sessionMessages", { count: session.messageCount }),
      ];
      if (runningBySession[session.id]) metaParts.push(t("chat.running"));
      const id = `session:${session.id}`;
      next.set(id, () => {
        void setActiveSession(session.id);
        closeGlobalSearch();
      });
      out.push({
        id,
        label: parent
          ? `${t("sidebar.branchOf")} · ${parent.title ?? t("chat.newChat")} / ${title}`
          : title,
        group: groupSessions,
        keys: [metaParts.join(" · ")],
      });
      sessionCount += 1;
      if (!hasQuery && sessionCount >= RECENT_SESSION_LIMIT) break;
    }

    // 消息：只遍历已加载的会话，每条命中消息一行；点开时带着关键词进入会话内搜索
    if (hasQuery) {
      const loadedIds = Object.keys(messagesBySession);
      const orderedIds = [
        ...sessions.map((s) => s.id).filter((id) => loadedIds.includes(id)),
        ...loadedIds.filter((id) => !sessions.some((s) => s.id === id)),
      ];
      let messageCount = 0;
      for (const sessionId of orderedIds) {
        if (messageCount >= MESSAGE_LIMIT) break;
        const messages = messagesBySession[sessionId];
        if (!messages) continue;
        for (const match of findMatches(messages, keyword)) {
          if (messageCount >= MESSAGE_LIMIT) break;
          const id = `message:${sessionId}:${match.messageId}`;
          next.set(id, () => {
            void setActiveSession(sessionId);
            closeGlobalSearch();
            setSessionSearchQuery(keyword);
            openSessionSearch();
          });
          out.push({
            id,
            label: match.snippet,
            group: groupMessages,
            keys: [
              t("search.messageIn", { title: titleById.get(sessionId) ?? t("chat.newChat") }),
              t("search.hitCount", { count: match.count }),
            ],
          });
          messageCount += 1;
        }
      }
    }

    // 设置：固定六个分类，按当前语言标签过滤
    for (const section of SETTINGS_SECTIONS) {
      const label = t(`settings.${section}`);
      if (!label.toLocaleLowerCase().includes(lowered)) continue;
      const id = `setting:${section}`;
      next.set(id, () => {
        closeGlobalSearch();
        openSettings(section);
      });
      out.push({
        id,
        label,
        group: groupSettings,
        keys: [t("search.openSettings")],
      });
    }

    // 命令：新建对话 + 切换主题（显示将要切到的主题）
    const commandEntries: { id: string; command: CommandId; label: string; hint?: string }[] = [
      { id: "command:new-chat", command: "new-chat", label: t("chat.newChat"), hint: "Ctrl+N" },
      {
        id: "command:toggle-theme",
        command: "toggle-theme",
        label: t("search.toggleTheme", {
          theme: t(theme === "dark" ? "app.themeLight" : "app.themeDark"),
        }),
      },
    ];
    for (const entry of commandEntries) {
      if (!entry.label.toLocaleLowerCase().includes(lowered)) continue;
      next.set(entry.id, () => {
        if (entry.command === "new-chat") void createSession();
        else void updateSettings({ theme: theme === "dark" ? "light" : "dark" });
        closeGlobalSearch();
      });
      out.push({
        id: entry.id,
        label: entry.label,
        group: groupCommands,
        keys: entry.hint ? [entry.hint] : [],
      });
    }

    actions.current = next;
    return out;
  }, [
    hasQuery,
    keyword,
    lowered,
    sessions,
    messagesBySession,
    runningBySession,
    theme,
    t,
    setActiveSession,
    closeGlobalSearch,
    setSessionSearchQuery,
    openSessionSearch,
    openSettings,
    createSession,
    updateSettings,
  ]);

  // 关键词变化或结果变化后回到首条结果
  useEffect(() => {
    setActiveId(commands[0]?.id ?? "");
  }, [commands]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 上下、Enter 由官方 palette 自己处理；这里只接管 Esc（关闭整块面板）
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeGlobalSearch();
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
          aria-label={t("search.globalTitle")}
          onKeyDown={handleKeyDown}
          className={cn(
            "fixed top-[12vh] left-1/2 z-50 w-[640px] max-w-[calc(100vw-2rem)] -translate-x-1/2 outline-none",
            "duration-150 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1 motion-reduce:animate-none",
          )}
        >
          <DialogTitle className="sr-only">{t("search.globalTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("search.globalDesc")}</DialogDescription>
          <CommandPalette
            commands={commands}
            query={query}
            activeId={activeId}
            onQueryChange={setQuery}
            onActiveChange={setActiveId}
            onRun={(id) => actions.current.get(id)?.()}
            className="max-w-none"
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
