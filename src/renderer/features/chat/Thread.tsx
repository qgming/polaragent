import {
  ActionBarPrimitive,
  AuiIf,
  BranchPickerPrimitive,
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
  ChevronLeftIcon,
  ChevronRightIcon,
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

/** 跨天分隔条：Elements 的 day-separator 用的就是这条「细线 + 眉题 + 细线」形状 */
function DayDivider({ timestamp }: { timestamp: Date | number }) {
  const { i18n, t } = useTranslation();
  const offset = dayOffset(timestamp);
  const label =
    offset === 0
      ? t("sidebar.today")
      : offset === 1
        ? t("sidebar.yesterday")
        : formatDayDate(timestamp, i18n.language);

  return (
    <div data-slot="day-divider" className="flex items-center gap-2.5 py-1">
      <span className="h-px flex-1 bg-foreground/[0.08]" />
      <span className={cn(mono, "text-foreground/30")}>{label}</span>
      <span className="h-px flex-1 bg-foreground/[0.08]" />
    </div>
  );
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
 * 重新生成后切换回复：上一版 / 第 n 版 / 下一版。
 * 位置在底部操作栏按钮的右侧，所以留的是左间距（原来在左侧时用的是负左外边距）。
 * 只有一条回复时（branchCount ≤ 1）由 hideWhenSingleBranch 整个隐藏。
 */
function BranchPicker({ className, ...rest }: BranchPickerPrimitive.Root.Props) {
  const { t } = useTranslation();
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root ms-1 inline-flex items-center text-xs text-muted-foreground",
        className,
      )}
      {...rest}
    >
      <BranchPickerPrimitive.Previous asChild>
        <TooltipIconButton tooltip={t("chat.searchPrev")}>
          <ChevronLeftIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Previous>
      <span className="aui-branch-picker-state font-medium tabular-nums">
        <BranchPickerPrimitive.Number /> / <BranchPickerPrimitive.Count />
      </span>
      <BranchPickerPrimitive.Next asChild>
        <TooltipIconButton tooltip={t("chat.searchNext")}>
          <ChevronRightIcon />
        </TooltipIconButton>
      </BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

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
 * 正在输出那条消息尾部的真实状态：有未完成的工具调用就报它的名字，否则是笼统的思考中。
 * 用词条键（字符串）而不是译文做选择器的返回值，Object.is 才稳定。
 */
function AssistantThinking() {
  const { t } = useTranslation();
  const labelKey = useAuiState((s) => {
    if (s.message.status?.type !== "running") return undefined;
    const pending = s.message.parts.find(
      (part) => part.type === "tool-call" && part.result === undefined,
    );
    if (pending?.type === "tool-call") return toolActiveLabelKey(pending.toolName);
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
        <TooltipIconButton tooltip={t("chat.editMessage")} className="aui-user-action-edit">
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

      <BranchPicker className="col-span-full col-start-1 row-start-3 justify-end" />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const isRunEnd = useContext(IsRunEndContext);
  const messageRunning = useAuiState((s) => s.message.status?.type === "running");

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
          运行状态固定在消息左上角：这条消息还没输出完就一直显示，
          不去跟正文抢位置、也不随正文增长往下漂。
        */}
        {messageRunning && <AssistantThinking />}
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
          <BranchPicker />
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

  // 命中键：消息 id + 全局序号。流式更新不会改变键，避免反复滚动；
  // 同一消息内切换命中时键变化，需要重新定位
  const hitKey = searchHit === null ? null : `${searchHit.messageId}#${searchHit.globalIndex}`;

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
        <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-1 flex-col px-4 pt-4">
          <div data-slot="aui_message-group" className="mb-2 flex flex-col gap-y-3 empty:hidden">
            {messages.map((message, index) => {
              const prev = messages[index - 1];
              const next = messages[index + 1];
              const isHit = searchHit?.messageId === message.id;
              // 下一条不是助手消息，说明本段运行到此结束 —— 操作栏挂在这一条上
              const isRunEnd = next?.role !== "assistant";
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
                      <ThreadPrimitive.MessageByIndex
                        index={index}
                        components={MESSAGE_COMPONENTS}
                      />
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
