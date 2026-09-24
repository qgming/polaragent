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
import { useActiveWorkingDir } from "@/renderer/features/chat/use-slash-commands";
import { settingsSections } from "@/renderer/features/settings/sections";
import { formatRelativeDay, formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { usePluginsStore } from "@/renderer/stores/plugins-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts/session";
import { findMatches } from "./find-matches";

/** 输入即搜的防抖时长 */
const DEBOUNCE_MS = 150;
/** 消息结果上限，避免长会话刷屏 */
const MESSAGE_LIMIT = 20;
/** 空输入时展示的最近会话数 */
const RECENT_SESSION_LIMIT = 5;

/**
 * 弹窗关闭时用的稳定空表。
 *
 * 必须是**模块级常量**：zustand 用 Object.is 比较选择器结果，
 * 每次返回一个新的 `{}` 会被判定为「快照变了」从而不停重渲
 * （与 SubagentPanel 的 EMPTY_RUNS 同一条纪律）。
 */
const EMPTY_SESSIONS: Record<string, ChatMessage[]> = {};

type CommandId = "new-chat" | "toggle-theme" | "open-stats";

/**
 * 统一搜索模态窗：侧栏搜索按钮与 Ctrl+K 打开同一个它，输入即搜，
 * 结果按 会话 → 消息 → 设置 → 命令 分组。
 *
 * 结果列表交给官方 CommandPalette 渲染（分组眉题、键盘上下、Enter、Esc 标记都由它提供），
 * 本组件只负责把四类结果映射成它的 PaletteCommand：
 *   label 是主文案，keys 是右侧那一串等宽标记（会话的更新时间、命中的位置、设置的去向、命令的快捷键）。
 * 官方组件按 label 自行过滤，因此这里仍按各自规则先筛好（消息要按正文命中而不是标题）。
 *
 * 消息结果只覆盖**本次运行已加载过**的会话：渲染层拿不到全库全文检索，
 * 点中一条消息时会切到该会话并请求定位到那条消息（见 Thread 的搜索跳转处理）。
 */
export function SearchModal() {
  const { t } = useTranslation();
  const open = useUiStore((s) => s.searchOpen);
  const closeSearch = useUiStore((s) => s.closeSearch);
  const jumpToMessage = useUiStore((s) => s.jumpToMessage);
  const openSettings = useUiStore((s) => s.openSettings);
  const openStats = useUiStore((s) => s.openStats);
  const sessions = useChatStore((s) => s.sessions);
  /**
   * 消息表**只在弹窗打开时订阅**。
   *
   * 为什么这是必要的：`messagesBySession` 是流式写入的热字段 —— 每个 token 的 flush
   * 都会换一次它的引用。无条件订阅意味着**每一次 token 都要重渲整个搜索弹窗**，
   * 哪怕它关着、哪怕命中的是用户根本没在看的子智能体会话。
   * 多子智能体并行时这条开销尤其明显（它们也在往同一张表里写）。
   *
   * 关着时返回一个稳定的空对象：zustand 用 Object.is 比较，常量引用不会触发重渲。
   * 打开时再订阅 —— 那时用户确实需要看到最新的搜索结果。
   */
  const messagesBySession = useChatStore((s) => (open ? s.messagesBySession : EMPTY_SESSIONS));
  const runningBySession = useChatStore((s) => s.runningBySession);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const createSession = useChatStore((s) => s.createSession);
  const theme = useSettingsStore((s) => s.settings?.theme);
  /*
    插件命令：只有**进程在跑**的插件才有（纯声明式插件不注册命令）。
    列表跟着插件启停变，所以它在 store 里、由 store 刷新，这里只读。
  */
  const pluginCommands = usePluginsStore((s) => s.commands);
  const runPluginCommand = usePluginsStore((s) => s.runCommand);
  // 命令多半要针对"当前会话在看的那个目录"做事，而主进程不知道那是哪个
  const workingDir = useActiveWorkingDir();
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
        closeSearch();
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

    // 消息：只遍历已加载的会话，每条命中消息一行；点开时切到该会话并请求定位到那条消息
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
            jumpToMessage(sessionId, match.messageId);
            closeSearch();
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

    /*
      设置：分栏清单取自**注册表**，文案键是描述子里的字面量。

      这里过去是 `` t(`settings.${section}`) `` —— 一个运行期拼出来的 i18n 键，
      它依赖「section id 恰好等于文案键的后缀」这条没人写下来的约定：
      改一个 id 会让搜索结果里显示成 `settings.foo`，而 scripts/check-i18n.mjs
      抓的是**编译期字面量**，拼串正好从它眼皮底下溜过去。
    */
    for (const section of settingsSections()) {
      const label = t(section.labelKey);
      if (!label.toLocaleLowerCase().includes(lowered)) continue;
      const id = `setting:${section.id}`;
      next.set(id, () => {
        closeSearch();
        openSettings(section.id);
      });
      out.push({
        id,
        label,
        group: groupSettings,
        keys: [t("search.openSettings")],
      });
    }

    // 命令：新建对话 + 切换主题（显示将要切到的主题）+ 打开数据统计
    const commandEntries: { id: string; command: CommandId; label: string; hint?: string }[] = [
      { id: "command:new-chat", command: "new-chat", label: t("chat.newChat"), hint: "Ctrl+N" },
      {
        id: "command:toggle-theme",
        command: "toggle-theme",
        label: t("search.toggleTheme", {
          theme: t(theme === "dark" ? "app.themeLight" : "app.themeDark"),
        }),
      },
      // 统计与设置一样是「面板型」入口：搜它的名字就能开，不必先知道它在侧栏哪颗图标下
      {
        id: "command:open-stats",
        command: "open-stats",
        label: t("stats.title"),
        hint: t("stats.subtitle"),
      },
    ];
    for (const entry of commandEntries) {
      if (!entry.label.toLocaleLowerCase().includes(lowered)) continue;
      next.set(entry.id, () => {
        if (entry.command === "new-chat") void createSession();
        else if (entry.command === "open-stats") openStats();
        else void updateSettings({ theme: theme === "dark" ? "light" : "dark" });
        closeSearch();
      });
      out.push({
        id: entry.id,
        label: entry.label,
        group: groupCommands,
        keys: entry.hint ? [entry.hint] : [],
      });
    }

    /*
      插件命令。
      **与内置命令同一组**（`groupCommands`）：对用户来说"新建对话"与"看看 Git 状态"
      是同一类东西 —— 都是"让某个东西做一件事"，分两组只会让他多扫一遍。

      命令清单来自 `plugins:commands`（只有**进程在跑**的插件才有），而那个列表
      跟着插件启停变。所以它在 store 里、由 store 负责刷新，这里只读。
    */
    for (const command of pluginCommands) {
      const label = `${command.pluginName}：${command.name}`;
      if (!label.toLocaleLowerCase().includes(lowered)) continue;
      const id = `plugin-command:${command.id}`;
      next.set(id, () => {
        /*
          执行是**异步**的，而命令面板要先关掉：不关的话用户会盯着一个不动的面板，
          而命令可能跑几秒。失败走 `plugins-store` 的 error（面板上能看到），
          不在这里弹窗 —— 命令面板正在关闭，弹什么都来不及看。
        */
        closeSearch();
        void runPluginCommand(command.id, "", workingDir ?? "");
      });
      out.push({
        id,
        label,
        group: groupCommands,
        // 描述进关键词：用户敲"仓库"时该能找到描述里写了"仓库"的那条命令
        keys: [command.description],
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
    closeSearch,
    jumpToMessage,
    openSettings,
    openStats,
    createSession,
    updateSettings,
    pluginCommands,
    runPluginCommand,
    workingDir,
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
      closeSearch();
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeSearch();
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
            placeholder={t("search.globalPlaceholder")}
            emptyLabel={t("search.noResults")}
            className="max-w-none"
          />
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
