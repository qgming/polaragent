import {
  ActionBarPrimitive,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  InfoIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { UserMessageAttachments } from "@/renderer/components/assistant-ui/elements/attachment.aui";
import { DaySeparatorRow } from "@/renderer/components/assistant-ui/elements/day-separator";
import {
  EmptyState,
  EmptyStateGreeting,
} from "@/renderer/components/assistant-ui/elements/empty-state";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import { dayOffset, formatDayDate, isSameDay } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";
import type { AskReply, AskRequest } from "@/shared/contracts/interaction";
import { ApprovalSection } from "./ApprovalSection";
import { AskSection } from "./AskSection";
import { Composer } from "./Composer";
import { MessageRail } from "./MessageRail";
import {
  AssistantMessageParts,
  IsRunStartContext,
  MessageError,
  UserMessageParts,
} from "./message-parts";
import { isMessageSequenceSynced } from "./message-seq";
import { useStickToBottom } from "./use-stick-to-bottom";

/**
 * 这条助手消息是不是所在运行段的最后一条。
 *
 * pi 的 harness 每遇到一次 message_start 就新开一条助手消息，所以「推理 → 工具 → 正文」
 * 这样一次运行会落成好几条相邻的助手消息。整段只在末尾挂一个底部操作栏。
 * 由 ThreadView 遍历时按邻居是否助手算好传进来，避免每条消息各自扫一遍整个列表。
 * 默认 true：渲染在消息流之外时按"末条"处理，操作栏仍可见。
 */
const IsRunEndContext = createContext(true);

/** 跨天分隔条：视觉取自 Elements 的 day-separator（细线 + 眉题 + 细线） */
function DayDivider({ timestamp }: { timestamp: Date | number }) {
  const { i18n, t } = useTranslation();
  const offset = dayOffset(timestamp);
  const label =
    offset === 0
      ? t("sidebar.today")
      : offset === 1
        ? t("sidebar.yesterday")
        : formatDayDate(timestamp, i18n.language);

  return <DaySeparatorRow label={label} />;
}

/**
 * 操作栏按钮：比通用的 TooltipIconButton 小一档（24px 按钮 / 16px 图标 → 22 / 14）。
 * 图标尺寸必须用 `!` 压过 Button 基类的 `[&_svg:not([class*='size-'])]:size-4`
 * —— 那条规则带 :not()，特异性比这里的 `[&_svg]` 高，不加 important 是压不住的。
 */
const ACTION_BUTTON = "size-5.5 [&_svg]:size-3.5!";

/**
 * 操作栏一行的高度：上间距与段落 / 思考块 / 工具块同用 --density-gap（舒适 16 / 紧凑 12），
 * min-h 恒等于「上间距 + 按钮高」，所以按钮的显隐（运行中收起、hover 才出现）不改变消息间距。
 */
const ACTION_BAR_ROW = "pt-(--density-gap) min-h-[calc(var(--density-gap)_+_1.375rem)]";

/**
 * 助手消息的底部操作栏：复制 + 重新生成 + 分支。
 * 运行中整条收起（hideWhenRunning）——重新生成会在半途截断当前运行。
 * 高度由外层的 ACTION_BAR_ROW 常驻预留，所以它的显隐不改变消息间距。
 */
function AssistantActionBar() {
  const { t } = useTranslation();
  const sessionId = useChatStore((s) => s.activeSessionId);
  // 这条助手消息对应的 pi 条目 id；流式中的临时消息还没有，此时不给分支入口
  const entryId = useAuiState((s) => {
    const custom = s.message.metadata?.custom as { entryId?: unknown } | undefined;
    return typeof custom?.entryId === "string" ? custom.entryId : undefined;
  });
  const canBranch = entryId !== undefined && sessionId !== null;

  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      className="aui-assistant-action-bar-root flex animate-in items-center gap-1 text-muted-foreground fade-in duration-200 motion-reduce:animate-none"
    >
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("common.copy")} className={ACTION_BUTTON}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in fade-in zoom-in-50 duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in fade-in zoom-in-75 duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("common.retry")} className={ACTION_BUTTON}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      {/* 分支：以这条消息为切点复制出新的会话（主进程 sessions.fork），并切到新会话 */}
      {canBranch && (
        <TooltipIconButton
          tooltip={t("chat.branchFromHere")}
          className={ACTION_BUTTON}
          onClick={() => void useChatStore.getState().forkSession(sessionId, entryId)}
        >
          <GitBranchIcon />
        </TooltipIconButton>
      )}
    </ActionBarPrimitive.Root>
  );
}

/**
 * 用户消息的操作栏：复制 + 编辑。
 *
 * 不用 `ActionBarPrimitive.Root` 包：它在隐藏时直接 `return null`（不渲染），
 * 于是「hover 才出现」的按钮在键盘与辅助技术下根本不存在 —— 而编辑没有别的入口。
 * 这里改成常驻 DOM、只切 CSS 可见性，Tab 进来时该行会自行显形。
 */
function UserActionBar() {
  const { t } = useTranslation();
  const beginEditMessage = useUiStore((s) => s.beginEditMessage);
  // 编辑的是这条消息：id 从 aui 的 message scope 取
  const messageId = useAuiState((s) => s.message.id);
  return (
    <div className="flex items-center gap-1 text-muted-foreground">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("common.copy")} className={ACTION_BUTTON}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in fade-in zoom-in-50 duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in fade-in zoom-in-75 duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton
          tooltip={t("chat.editMessage")}
          className={cn("aui-user-action-edit", ACTION_BUTTON)}
          onClick={() => beginEditMessage(messageId)}
        >
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </div>
  );
}

function UserMessage() {
  const running = useAuiState((s) => s.thread.isRunning);
  const isSystem = useAuiState((s) => {
    const custom = s.message.metadata?.custom as { origin?: unknown } | undefined;
    return custom?.origin === "system";
  });

  if (isSystem) {
    return <SystemNoticeRow />;
  }

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      // group/msg：下方操作栏的 hover 显隐挂在这个消息根上，鼠标落在消息任意处都能唤出
      className="group/msg grid animate-in grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-xl bg-muted px-4 py-2 text-foreground empty:hidden">
          <UserMessageParts />
        </div>
        {/*
          hover 或键盘聚焦时显形的操作栏，坐在气泡下方的常驻高度里。
          上间距与助手那边同源（ACTION_BAR_ROW 的 --density-gap），两条流的节奏因此一致；
          关键是**常驻 DOM、只切 CSS 可见性** —— 换成条件挂载会让按钮在 Tab 序列里消失，
          而编辑没有别的入口，键盘与辅助技术就再也用不到它。
          运行中不给编辑入口（会与流式冲突），此时这个容器只占位。
        */}
        <div
          className={cn(
            "flex items-center justify-end",
            ACTION_BAR_ROW,
            "peer-empty:hidden",
            "pointer-events-none opacity-0 transition-opacity duration-200 motion-reduce:transition-none",
            "group-hover/msg:pointer-events-auto group-hover/msg:opacity-100",
            "focus-within:pointer-events-auto focus-within:opacity-100",
          )}
        >
          {running ? null : <UserActionBar />}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const isRunEnd = useContext(IsRunEndContext);

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative animate-in duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        // flex + gap：块（思考 / 工具 / 正文）之间由 gap 统一控制，块自身不带纵向外边距
        // flex + gap：块（思考 / 工具 / 正文）之间由 gap 统一控制，块自身不带纵向外边距；
        // 间距走 --density-gap（舒适 16px / 紧凑 12px，见 index.css）
        className="flex flex-col gap-y-(--density-gap) px-2 leading-relaxed text-foreground wrap-break-word"
      >
        {/*
          正文（运行状态行 / 推理 / 工具 / Markdown）与右侧「子智能体」面板共用一份实现
          （见 message-parts 的文件头），本组件只负责这段之外属于**主线程**的东西：
          状态行在不在段首、整段是否还在跑由 AssistantMessageParts 自己按上下文判定，
          这里因此不给附加闸门（恒 true）。
        */}
        <AssistantMessageParts showRunStatus />
        <MessageError />
      </div>

      {/*
        段尾那块位置：底部操作栏。运行中由 hideWhenRunning 整条收起，
        状态指示已经上移到消息顶部，这里不再兼任。
        上间距与段落 / 思考块 / 工具块同用 --density-gap，所以操作栏与正文的间距、
        以及块与块之间的间距是同一个值；高度常驻（ACTION_BAR_ROW 的 min-h），
        按钮显隐时不改变消息间距。
      */}
      {isRunEnd && (
        <div
          data-slot="aui-assistant-message-footer"
          className={cn("ms-2 flex items-center", ACTION_BAR_ROW)}
        >
          <AssistantActionBar />
        </div>
      )}
    </MessagePrimitive.Root>
  );
}
/**
 * 系统通知行：居中、弱化的提示行，带一个小图标。由 UserMessage 在 origin === "system" 时渲染。
 * 不加用户头像、不加气泡样式、不加操作栏。
 */
function SystemNoticeRow() {
  const { t } = useTranslation();

  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="system"
      role="status"
      aria-label={t("chat.systemNoticeLabel")}
      className="flex animate-in items-center justify-center gap-1.5 px-4 py-2 duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none"
    >
      <InfoIcon className="size-3.5 shrink-0 text-ink-3" aria-hidden />
      <span className="text-center text-xs leading-relaxed text-ink-3">
        <UserMessageParts />
      </span>
    </MessagePrimitive.Root>
  );
}

/** MessageByIndex 的 components 配置（该模式自带 message scope） */
const MESSAGE_COMPONENTS = { UserMessage, AssistantMessage };

function ScrollToBottom() {
  const { t } = useTranslation();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("chat.scrollToBottom")}
        variant="outline"
        className="aui-thread-scroll-to-bottom absolute -top-12 z-10 self-center rounded-full p-4 disabled:invisible dark:border-border dark:bg-background dark:hover:bg-accent"
      >
        <ArrowDownIcon />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
}

interface ThreadViewProps {
  /** 待审批项（来自并行车道的 chat-store）；渲染在消息流尾部 */
  approvals?: ApprovalRequest[];
  onResolve?: (id: string, decision: ApprovalDecision, note?: string) => void;
  /** 待作答的提问（同样来自 chat-store）；与审批卡同区渲染 */
  asks?: AskRequest[];
  onRespond?: (id: string, reply: AskReply) => void;
}

/**
 * 对话线程：按 assistant-ui Thread 的结构组合 primitives 与 Elements 组件。
 * 布局与 thread.aui.tsx 一致，差异只有三处（都是为了保住本应用既有的行为）：
 * 逐条渲染消息以便插入跨天分隔与搜索定位、审批卡与提问卡接在消息流尾部、
 * Composer 用本应用的控制台版本。
 */
export function ThreadView({ approvals = [], onResolve, asks = [], onRespond }: ThreadViewProps) {
  const { t } = useTranslation();
  const messages = useAuiState((s) => s.thread.messages);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // 流式输出只在「用户本来就在底部」时跟随；上滑一下即停，到底或点按钮稍候恢复
  useStickToBottom(viewportRef);

  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const searchJump = useUiStore((s) => s.searchJump);
  const clearSearchJump = useUiStore((s) => s.clearSearchJump);
  /** 属于当前会话的跳转目标；别的会话的目标（切换过程中可能残留）一律忽略 */
  const jump = searchJump !== null && searchJump.sessionId === activeSessionId ? searchJump : null;

  // 离开目标会话后丢弃跳转目标：否则回到该会话会留下一条「只有标记、不再滚动」的残留
  useEffect(() => {
    if (searchJump !== null && searchJump.sessionId !== activeSessionId) clearSearchJump();
  }, [searchJump, activeSessionId, clearSearchJump]);

  const hasMore = useChatStore(
    (s) => s.activeSessionId !== null && s.hasMoreBySession[s.activeSessionId] === true,
  );
  const loadingOlder = useChatStore(
    (s) => s.activeSessionId !== null && s.loadingOlderBySession[s.activeSessionId] === true,
  );
  /** store 里当前会话的消息：跳转判据的真值来源，见 domSynced */
  const sessionMessages = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.messagesBySession[s.activeSessionId],
  );

  /**
   * 向上滚到顶就看更早的消息：不要求用户去点按钮。
   *
   * 观察的是消息组顶部那个哨兵，rootMargin 让它提前 400px 触发（还没真到顶就开始取），
   * 取完内容前插、哨兵被推上去，因此要等用户再往上滚才会再次触发 —— 不需要额外的节流。
   * `loadingBySession` 是并发闸门：同一会话已有一次翻页在飞就跳过。
   */
  useEffect(() => {
    if (!hasMore) return;
    const root = viewportRef.current;
    const target = sentinelRef.current;
    if (root === null || target === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        const store = useChatStore.getState();
        const id = store.activeSessionId;
        if (id === null || store.loadingOlderBySession[id] === true) return;
        void store.loadMessages(id, { before: true });
      },
      { root, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
    // 只依赖 hasMore：换会话时它必然重算，够用了；回调里读的是 store 的最新状态
  }, [hasMore]);

  /** 已消费的跳转键（消息 id + token）：同一目标只滚一次 */
  const consumedJumpRef = useRef<string | null>(null);

  /**
   * 这批 messages 是否已经跟上 store 的当前会话（判据见 isMessageSequenceSynced）。
   *
   * 这件事对跳转是致命的：fork 出来的会话与源会话**共用消息 id**
   *（见 src/main/pisdk/session-store.test.ts），只按 id 判定就会在旧会话的 DOM 上
   * 命中同 id 节点、把跳转提前消费掉，等新会话真的渲染出来时反而不滚了 ——
   * 而左侧竖条又按 id 正确落在目标上，把失败掩盖过去。
   *
   * 因此只有在两边逐条一致、且运行中的那一条乐观消息被正确放行时才允许消费。
   */
  /** 渲染侧此刻是否允许比 store 多一条尾部乐观助手消息（条件与运行时一致，见 message-seq） */
  const uiRunning = useAuiState((s) => s.thread.isRunning);
  const optimisticTail = uiRunning && sessionMessages?.at(-1)?.role !== "assistant";
  const domSynced = useMemo(
    () =>
      sessionMessages !== undefined &&
      isMessageSequenceSynced(sessionMessages, messages, optimisticTail),
    [sessionMessages, messages, optimisticTail],
  );

  /**
   * 搜索模态窗点中消息后的落地：滚到那条消息，并留下左侧竖条标记（见消息容器的 data-search-hit）。
   *
   * 依赖 messages 而不是只依赖跳转目标：切换会话后消息是异步加载的，
   * 目标 DOM 要到下一次消息变化才可能出现，因此定位必须在消息变化时重试，
   * 未找到时**不**记消费，留给后面的渲染再试。
   */
  useEffect(() => {
    if (jump === null || !domSynced) return;
    const key = `${jump.messageId}#${jump.token}`;
    if (consumedJumpRef.current === key) return;
    // 目标消息不在这个会话里（或还在更早的分页中未加载）：不消费，等后续渲染再试
    if (!sessionMessages?.some((message) => message.id === jump.messageId)) return;
    const target = viewportRef.current?.querySelector(
      `[data-message-id="${CSS.escape(jump.messageId)}"]`,
    );
    if (!(target instanceof HTMLElement)) return;
    consumedJumpRef.current = key;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [jump, domSynced, sessionMessages]);

  /**
   * 当前（末尾）那次运行的起点下标：从末尾往前扫连续的助手消息。
   * -1 表示末尾不是助手消息（没有在跑的运行）。
   * 状态行只挂在这一条上；用「末尾连续段」而不是「任意段首」，见 IsRunStartContext 的说明。
   */
  let activeRunStart = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== "assistant") break;
    activeRunStart = i;
  }

  return (
    <ThreadPrimitive.Root
      // relative：左侧消息地图（MessageRail）要相对它绝对定位，落在视口左侧的留白里
      className="aui-root aui-thread-root relative flex min-h-0 flex-1 flex-col"
      style={{
        ["--thread-max-width" as string]: "var(--layout-thread-max-width)",
        ["--composer-bg" as string]: "var(--card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        // 关掉库自带的自动滚动，改由 useStickToBottom 接管：它的「向下滚但没到底」那一支是
        // 空分支，会在用户稍微往下滑时把跟随重新打开 —— 手感上就是滚动被抢。
        autoScroll={false}
        /**
         * 连「运行开始就滚到底」也必须显式关掉 —— 这一条**不**受上面的 autoScroll 管辖。
         *
         * 库把四件事分成两组：autoScroll 只管「内容长高时是否跟着贴底」
         *（useThreadViewportAutoScroll.js 的 resizeRef 分支），而
         * scrollToBottomOnRunStart / OnInitialize / OnThreadSwitch 是三个**独立**开关，
         * 默认全为 true，各自挂在自己的事件上。runStart 那条尤其要紧：
         *
         *   useAuiEvent("thread.runStart", () => {
         *     if (!scrollToBottomOnRunStart) return;
         *     if (turnAnchor === "top") return;   // 我们的 turnAnchor 是默认的 bottom
         *     scheduleScrollToBottom("auto");
         *   });
         *
         * 我们的 turnAnchor 正是 bottom，所以那个早退不生效 —— 之前只关 autoScroll 时，
         * 每来一次运行开始都会强制滚到底并把 followBottomRef 写回 true，
         * 用户的上滑姿态被反复清掉，表现就是「输出过程中滑不动」。
         *
         * 只关这一个：首次进入（OnInitialize）与切会话（OnThreadSwitch）滚到底是对的，
         * 那两个保持库默认。
         */
        scrollToBottomOnRunStart={false}
        // turnAnchor="bottom"（库默认）保持不动：配合上面的两个开关之后它只参与
        // 锚点计算，不再自己滚动 —— 贴底、松开、恢复全部由 useStickToBottom 决定。
        // 之前用的是 turnAnchor="top"（把用户消息钉在顶部）：它会在回合开始时平滑滚到顶锚，
        // 并在同一次运行冒出第二条助手消息时拆掉顶部占位块，scrollHeight 塌陷导致浏览器钳制
        // scrollTop —— 流式期间看着就是「滚动位置被抢」。自由滚动优先，故改回默认。
        data-slot="aui_thread-viewport"
        className="app-scrollbar relative min-h-0 flex-1 overflow-y-auto"
      >
        {/*
          min-h-full 而不是 flex-1：这里的父级是 Viewport（overflow-y-auto），不是 flex 容器，
          flex-1 完全无效 —— 容器只有内容高，脚注上的 mt-auto 就没有可分配空间，
          输入框会贴着消息往下滑。撑到至少一屏高，mt-auto 才能把它压到底；
          内容超过一屏后由脚注自己的 sticky bottom-0 接管。
        */}
        <div className="mx-auto flex min-h-full w-full max-w-(--thread-max-width) flex-col px-4 pt-4">
          {/*
            消息组顶部的哨兵：滚到附近就自动取更早的一页（见上面的 IntersectionObserver）。
            它必须在消息组**之前**，这样前插内容会把哨兵顶出视野，避免连续触发。
          */}
          <div ref={sentinelRef} aria-hidden className="h-px shrink-0" />
          {loadingOlder && (
            <div
              className={cn("pb-1 text-center", mono, "text-ink-4")}
              role="status"
              aria-live="polite"
            >
              {t("chat.loadingOlder")}
            </div>
          )}
          {/*
            对话正文的字体与字号挂在这一层：fontSize 取自设置的 --chat-font-size（<html> 上），
            字体取自 --chat-font。消息组同时包住用户消息、助手正文、推理与工具输出，因此
            「对话字号」一改整段正文都跟着走；审批卡（下方 ApprovalSection）与 Composer
            （脚注）在这一层之外，不受影响（Composer 自己带 text-sm）。
            块间距交给 --density-gap：舒适 16px / 紧凑 12px。
          */}
          <div
            data-slot="aui_message-group"
            style={{ fontFamily: "var(--chat-font)", fontSize: "var(--chat-font-size)" }}
            className="mb-2 flex flex-col gap-y-(--density-gap) empty:hidden"
          >
            {messages.map((message, index) => {
              const prev = messages[index - 1];
              const next = messages[index + 1];
              const isSearchTarget = jump?.messageId === message.id;
              // 下一条不是助手消息，说明本段运行到此结束 —— 操作栏挂在这一条上
              const isRunEnd = next?.role !== "assistant";
              // 只有**当前这次**运行的段首亮状态行（见 activeRunStart 的说明）
              const isRunStart = index === activeRunStart;
              return (
                <Fragment key={message.id}>
                  {prev !== undefined && !isSameDay(prev.createdAt, message.createdAt) && (
                    <DayDivider timestamp={message.createdAt} />
                  )}
                  {/* 搜索落点用内阴影做左侧栏（gutter bar），避免出现/消失时引起排版跳动 */}
                  <div
                    data-message-id={message.id}
                    data-search-hit={isSearchTarget ? "true" : undefined}
                    className={cn(
                      "relative rounded-md",
                      isSearchTarget &&
                        "shadow-[inset_2px_0_0_0_color-mix(in_oklab,var(--foreground)_35%,transparent)]",
                    )}
                  >
                    <IsRunEndContext.Provider value={isRunEnd}>
                      <IsRunStartContext.Provider value={isRunStart}>
                        <ThreadPrimitive.MessageByIndex
                          index={index}
                          components={MESSAGE_COMPONENTS}
                        />
                      </IsRunStartContext.Provider>
                    </IsRunEndContext.Provider>
                  </div>
                </Fragment>
              );
            })}
            {messages.length === 0 && (
              <ThreadPrimitive.Empty>
                <div className="flex flex-1 items-center justify-center py-24">
                  <EmptyState>
                    <EmptyStateGreeting>{t("chat.welcome")}</EmptyStateGreeting>
                    <p className="text-center text-sm leading-relaxed text-ink-3">
                      {t("chat.welcomeSubtitle")}
                    </p>
                  </EmptyState>
                </div>
              </ThreadPrimitive.Empty>
            )}
          </div>

          {/* 审批卡接在消息流尾部（提问卡不在这里：它固定在输入框上方，见 ViewportFooter） */}
          <ApprovalSection requests={approvals} onResolve={onResolve} />

          {/*
            脚注带是**透明**的：消息会从 Composer 身下滚过，衬在它四周，
            靠 Composer 自己的不透明面 + --composer-shadow 把它抬起来（见 index.css）。
            这里不铺 bg-background —— 铺了就成一条把内容盖掉的横带，输入框也就不浮了。
          */}
          <ThreadPrimitive.ViewportFooter
            // data-slot 供消息地图测量脚注高度（刻度条要避开输入框，见 MessageRail）
            data-slot="aui_thread-viewport-footer"
            className="sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible pt-4 pb-4"
          >
            <ScrollToBottom />
            {/*
              提问卡固定在输入框**上方**、不跟随消息流：模型问话时用户多半正在读别处，
              卡片跟着消息尾部滚走等于把唯一能作答的入口藏起来。放在 sticky 脚注里
              与 Composer 同宽同层（px-4 与 Composer 外层的水平内边距一致）。
            */}
            {asks.length > 0 && (
              <div className="px-4">
                <AskSection requests={asks} onRespond={onRespond} />
              </div>
            )}
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>

      {/* 左侧消息地图：一条消息一格，hover 出预览、点击跳到那条 */}
      <MessageRail messages={messages} viewportRef={viewportRef} />
    </ThreadPrimitive.Root>
  );
}
