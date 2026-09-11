import {
  ActionBarPrimitive,
  AuiIf,
  ErrorPrimitive,
  type FileMessagePartComponent,
  groupPartByType,
  type ImageMessagePartComponent,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import {
  ArrowDownIcon,
  CheckIcon,
  CopyIcon,
  GitBranchIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import { createContext, Fragment, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { UserMessageAttachments } from "@/renderer/components/assistant-ui/elements/attachment.aui";
import {
  EmptyState,
  EmptyStateGreeting,
} from "@/renderer/components/assistant-ui/elements/empty-state";
import { File } from "@/renderer/components/assistant-ui/elements/file";
import { DaySeparatorRow } from "@/renderer/components/assistant-ui/elements/day-separator";
import { Image } from "@/renderer/components/assistant-ui/elements/image";
import { MarkdownText } from "@/renderer/components/assistant-ui/elements/markdown-text";
import {
  Reasoning,
  ReasoningContent,
  ReasoningRoot,
  ReasoningText,
  ReasoningTrigger,
} from "@/renderer/components/assistant-ui/elements/reasoning.aui";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { ThinkingIndicator } from "@/renderer/components/assistant-ui/elements/thinking-indicator";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import type { SessionSearchHit } from "@/renderer/features/search";
import { dayOffset, formatDayDate, isSameDay } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";
import { ApprovalSection } from "./ApprovalSection";
import { Composer } from "./Composer";
import { ToolCallPart, ToolRunGroup, toolActiveLabelKey } from "./ToolParts";

/**
 * 这条助手消息是不是所在运行段的最后一条。
 *
 * pi 的 harness 每遇到一次 message_start 就新开一条助手消息，所以「推理 → 工具 → 正文」
 * 这样一次运行会落成好几条相邻的助手消息。整段只在末尾挂一个底部操作栏。
 * 由 ThreadView 遍历时按邻居是否助手算好传进来，避免每条消息各自扫一遍整个列表。
 * 默认 true：渲染在消息流之外时按"末条"处理，操作栏仍可见。
 */
const IsRunEndContext = createContext(true);

/**
 * 这条助手消息是不是**当前正在跑的那次运行**的第一条。
 *
 * 状态行只挂在这一条上：一次运行会落成好几条相邻的助手消息，状态要显示在整段的左上角，
 * 而不是当前恰好在流式的那一条（它会随着工具调用往后挪）。
 * 必须是「当前这次」而不是「任一次」—— 否则历史上每次运行的段首都会在任一次运行期间亮起。
 * 默认 true：渲染在消息流之外时按"段首"处理。
 */
const IsRunStartContext = createContext(true);

/**
 * 助手消息的 part 分组：连续推理与工具调用折进「思维链」组，其余按类型单独出。
 * 这张表决定折叠边界，改它等于改消息的阅读节奏，不要随手加项。
 */
const GROUP_BY = groupPartByType({
  reasoning: ["group-chainOfThought", "group-reasoning"],
  "tool-call": ["group-chainOfThought", "group-tool"],
  "standalone-tool-call": [],
});

/** 用户消息里的文本不做 Markdown 解析，原样保留换行 */
const USER_PARTS = {
  Text: ({ text }: { text: string }) => <p className="whitespace-pre-wrap">{text}</p>,
} satisfies MessagePrimitive.Parts.Props["components"];

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

function MessageError() {
  return (
    <MessagePrimitive.Error>
      <ErrorPrimitive.Root className="aui-message-error-root mt-2 rounded-md border border-destructive bg-destructive/10 p-3 text-sm text-destructive dark:bg-destructive/5">
        <ErrorPrimitive.Message className="aui-message-error-message line-clamp-2" />
      </ErrorPrimitive.Root>
    </MessagePrimitive.Error>
  );
}

const ACTION_BAR_HEIGHT = "min-h-7.5 pt-1.5";

/**
 * 运行秒数。官方没有 selector —— `metadata.timing` 要等消息结束才定下来 —— 所以自己起计时器。
 */
function useElapsedLabel(active: boolean): string | undefined {
  const [label, setLabel] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!active) {
      setLabel(undefined);
      return;
    }
    const start = Date.now();
    setLabel("0s");
    const id = setInterval(() => {
      setLabel(`${Math.round((Date.now() - start) / 1000)}s`);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return label;
}

/**
 * 运行状态行：整段回复还在跑时展示，有未完成的工具调用就报它的名字，否则是笼统的思考中。
 *
 * 标签从**线程**里取而不是从所在消息取：状态行挂在段首，而正在流式的往往已经是后面那几条
 * （工具调用会把运行切成多条助手消息），只看自己这条会读不到在跑的工具。
 * 只看最后一条助手消息：一次运行里只有它在流式；从尾部往前找，找到就停。
 * 用词条键（字符串）而不是译文做选择器的返回值，Object.is 才稳定。
 */
function AssistantThinking() {
  const { t } = useTranslation();
  const labelKey = useAuiState((s) => {
    if (!s.thread.isRunning) return undefined;
    for (let i = s.thread.messages.length - 1; i >= 0; i -= 1) {
      const message = s.thread.messages[i];
      if (message?.role !== "assistant") continue;
      if (message.status?.type !== "running") break;
      const pending = message.parts.find(
        (part) => part.type === "tool-call" && part.result === undefined,
      );
      return pending?.type === "tool-call"
        ? toolActiveLabelKey(pending.toolName)
        : "tools.thinking";
    }
    return "tools.thinking";
  });
  const elapsed = useElapsedLabel(labelKey !== undefined);

  if (labelKey === undefined) return null;
  return <ThinkingIndicator label={t(labelKey)} elapsed={elapsed} />;
}

/**
 * 助手消息的底部操作栏：复制 + 重新生成 + 分支。
 * 运行中整条收起（hideWhenRunning）——重新生成会在半途截断当前运行。
 * 高度由外层的 ACTION_BAR_HEIGHT 常驻预留，所以它的显隐不改变消息间距。
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
        <TooltipIconButton tooltip={t("common.copy")}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="animate-in fade-in zoom-in-50 duration-200 ease-out" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="animate-in fade-in zoom-in-75 duration-150" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("common.retry")}>
          <RefreshCwIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
      {/* 分支：以这条消息为切点复制出新的会话（主进程 sessions.fork），并切到新会话 */}
      {canBranch && (
        <TooltipIconButton
          tooltip={t("chat.branchFromHere")}
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
        <TooltipIconButton tooltip={t("common.copy")}>
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
          className="aui-user-action-edit"
          onClick={() => beginEditMessage(messageId)}
        >
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </div>
  );
}

const UserFilePart: FileMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-file" className="py-1">
    <File {...part} />
  </div>
);

const UserImagePart: ImageMessagePartComponent = (part) => (
  <div data-slot="aui_user-message-image" className="py-1">
    <Image {...part} />
  </div>
);

function UserMessage() {
  const running = useAuiState((s) => s.thread.isRunning);

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
          <MessagePrimitive.Parts
            components={{ ...USER_PARTS, File: UserFilePart, Image: UserImagePart }}
          />
        </div>
        {/*
          hover 或键盘聚焦时显形的操作栏，坐在气泡下方的常驻高度里。
          高度与助手那边同值（ACTION_BAR_HEIGHT），两条流的节奏因此一致；
          关键是**常驻 DOM、只切 CSS 可见性** —— 换成条件挂载会让按钮在 Tab 序列里消失，
          而编辑没有别的入口，键盘与辅助技术就再也用不到它。
          运行中不给编辑入口（会与流式冲突），此时这个容器只占位。
        */}
        <div
          className={cn(
            "flex items-center justify-end",
            ACTION_BAR_HEIGHT,
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
  const isRunStart = useContext(IsRunStartContext);
  // 整段是否还在跑：状态行挂在段首，所以看的是线程而不是这条消息
  const runRunning = useAuiState((s) => s.thread.isRunning);

  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative animate-in duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        // flex + gap：块（思考 / 工具 / 正文）之间由 gap 统一控制，块自身不带纵向外边距
        className="flex flex-col gap-y-3 px-2 leading-relaxed text-foreground wrap-break-word"
      >
        {/*
          运行状态固定在**整段回复**的左上角：只在段首渲染，且整段还在跑时一直显示。
          不去跟正文抢位置、也不随正文增长往下漂。
        */}
        {isRunStart && runRunning && <AssistantThinking />}
        <MessagePrimitive.GroupedParts groupBy={GROUP_BY} indicator="never">
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                // 思维链把推理与工具折在一起，这里也要 flex + gap，否则组内两块贴在一起
                return (
                  <div data-slot="aui_chain-of-thought" className="flex flex-col gap-y-3">
                    {children}
                  </div>
                );
              case "group-tool":
                return <ToolRunGroup indices={part.indices}>{children}</ToolRunGroup>;
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  // ghost：思考块不描边，触发行直接坐在正文左线上
                  <ReasoningRoot variant="ghost" streaming={running}>
                    <ReasoningTrigger active={running} />
                    <ReasoningContent aria-busy={running}>
                      <ReasoningText>{children}</ReasoningText>
                    </ReasoningContent>
                  </ReasoningRoot>
                );
              }
              case "text":
                return <MarkdownText />;
              case "reasoning":
                return <Reasoning {...part} />;
              case "tool-call":
                return part.toolUI ?? <ToolCallPart {...part} />;
              case "data":
                return part.dataRendererUI;
              case "file":
                return (
                  <div data-slot="aui_assistant-message-file" className="py-1">
                    <File {...part} />
                  </div>
                );
              case "image":
                return (
                  <div data-slot="aui_assistant-message-image" className="py-1">
                    <Image {...part} />
                  </div>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      {/*
        段尾那块位置：底部操作栏。运行中由 hideWhenRunning 整条收起，
        状态指示已经上移到消息顶部，这里不再兼任。
        高度常驻（ACTION_BAR_HEIGHT），所以它显隐时不改变消息间距。
      */}
      {isRunEnd && (
        <div
          data-slot="aui_assistant-message-footer"
          className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
        >
          <AssistantActionBar />
        </div>
      )}
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
  /** 会话内搜索的当前命中：定位并高亮对应消息 */
  searchHit?: SessionSearchHit | null;
}

/**
 * 对话线程：按 assistant-ui Thread 的结构组合 primitives 与 Elements 组件。
 * 布局与 thread.aui.tsx 一致，差异只有三处（都是为了保住本应用既有的行为）：
 * 逐条渲染消息以便插入跨天分隔与搜索定位、审批卡接在消息流尾部、Composer 用本应用的控制台版本。
 */
export function ThreadView({ approvals = [], onResolve, searchHit = null }: ThreadViewProps) {
  const { t } = useTranslation();
  const messages = useAuiState((s) => s.thread.messages);
  const viewportRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const hasMore = useChatStore(
    (s) => s.activeSessionId !== null && s.hasMoreBySession[s.activeSessionId] === true,
  );  const loadingOlder = useChatStore(
    (s) => s.activeSessionId !== null && s.loadingOlderBySession[s.activeSessionId] === true,
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

  // 命中键：消息 id + 全局序号。流式更新不会改变键，避免反复滚动；
  // 同一消息内切换命中时键变化，需要重新定位
  const hitKey = searchHit === null ? null : `${searchHit.messageId}#${searchHit.globalIndex}`;

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

  useEffect(() => {
    if (hitKey === null) return;
    const messageId = hitKey.slice(0, hitKey.lastIndexOf("#"));
    const target = viewportRef.current?.querySelector(
      `[data-message-id="${CSS.escape(messageId)}"]`,
    );
    if (!(target instanceof HTMLElement)) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  }, [hitKey]);

  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root flex min-h-0 flex-1 flex-col"
      style={{
        ["--thread-max-width" as string]: "var(--layout-thread-max-width)",
        ["--composer-bg" as string]: "var(--card)",
        ["--composer-radius" as string]: "1.5rem",
        ["--composer-padding" as string]: "8px",
      }}
    >
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        turnAnchor="top"
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
              className={cn("pb-1 text-center", mono, "text-foreground/35")}
              role="status"
              aria-live="polite"
            >
              {t("chat.loadingOlder")}
            </div>
          )}
          <div data-slot="aui_message-group" className="mb-2 flex flex-col gap-y-3 empty:hidden">
            {messages.map((message, index) => {
              const prev = messages[index - 1];
              const next = messages[index + 1];
              const isHit = searchHit?.messageId === message.id;
              // 下一条不是助手消息，说明本段运行到此结束 —— 操作栏挂在这一条上
              const isRunEnd = next?.role !== "assistant";
              // 只有**当前这次**运行的段首亮状态行（见 activeRunStart 的说明）
              const isRunStart = index === activeRunStart;
              return (
                <Fragment key={message.id}>
                  {prev !== undefined && !isSameDay(prev.createdAt, message.createdAt) && (
                    <DayDivider timestamp={message.createdAt} />
                  )}
                  {/* 命中用内阴影做左侧栏（gutter bar），避免切高亮时引起排版跳动 */}
                  <div
                    data-message-id={message.id}
                    data-search-hit={isHit ? "true" : undefined}
                    className={cn(
                      "relative rounded-md",
                      isHit &&
                        "shadow-[inset_2px_0_0_0_color-mix(in_oklab,var(--foreground)_35%,transparent)]",
                    )}
                  >
                    {isHit && searchHit !== null && (
                      <div className={cn("pt-1", mono, "text-foreground/45")}>
                        {t("search.hitCount", { count: searchHit.count })}
                        {" · "}
                        {searchHit.indexInMessage + 1}/{searchHit.count}
                      </div>
                    )}
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
                    <p className="text-center text-sm leading-relaxed text-foreground/62">
                      {t("chat.welcomeSubtitle")}
                    </p>
                  </EmptyState>
                </div>
              </ThreadPrimitive.Empty>
            )}
          </div>

          {/* 审批卡接在消息流尾部，与 Composer 之前 */}
          <ApprovalSection requests={approvals} onResolve={onResolve} />

          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mt-auto flex flex-col gap-4 overflow-visible bg-background pt-4 pb-4">
            <ScrollToBottom />
            <Composer />
          </ThreadPrimitive.ViewportFooter>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
