import {
  ActionBarMorePrimitive,
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
  DownloadIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RefreshCwIcon,
} from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
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
import { ToolFallback } from "@/renderer/components/assistant-ui/elements/tool-fallback.aui";
import {
  ToolGroupContent,
  ToolGroupRoot,
  ToolGroupTrigger,
} from "@/renderer/components/assistant-ui/elements/tool-group.aui";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import type { SessionSearchHit } from "@/renderer/features/search";
import { dayOffset, formatDayDate, isSameDay } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import type { ApprovalDecision, ApprovalRequest } from "@/shared/contracts/approval";
import { ApprovalSection } from "./ApprovalSection";
import { Composer } from "./Composer";

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

function BranchPicker({ className, ...rest }: BranchPickerPrimitive.Root.Props) {
  const { t } = useTranslation();
  return (
    <BranchPickerPrimitive.Root
      hideWhenSingleBranch
      className={cn(
        "aui-branch-picker-root -ms-2 me-2 inline-flex items-center text-xs text-muted-foreground",
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

function AssistantActionBar() {
  const { t } = useTranslation();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="aui-assistant-action-bar-root flex animate-in gap-1 text-muted-foreground fade-in duration-200"
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
      <ActionBarMorePrimitive.Root>
        <ActionBarMorePrimitive.Trigger asChild>
          <TooltipIconButton tooltip={t("common.more")} className="data-[state=open]:bg-accent">
            <MoreHorizontalIcon />
          </TooltipIconButton>
        </ActionBarMorePrimitive.Trigger>
        <ActionBarMorePrimitive.Content
          side="bottom"
          align="start"
          sideOffset={6}
          className="aui-action-bar-more-content z-50 min-w-[8rem] overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
        >
          <ActionBarPrimitive.ExportMarkdown asChild>
            <ActionBarMorePrimitive.Item className="aui-action-bar-more-item flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground">
              <DownloadIcon className="size-4" />
              {t("chat.exportMarkdown")}
            </ActionBarMorePrimitive.Item>
          </ActionBarPrimitive.ExportMarkdown>
        </ActionBarMorePrimitive.Content>
      </ActionBarMorePrimitive.Root>
    </ActionBarPrimitive.Root>
  );
}

function UserActionBar() {
  const { t } = useTranslation();
  return (
    <ActionBarPrimitive.Root
      hideWhenRunning
      autohide="not-last"
      className="flex flex-col items-end"
    >
      <ActionBarPrimitive.Edit asChild>
        <TooltipIconButton tooltip={t("chat.editMessage")} className="aui-user-action-edit">
          <PencilIcon />
        </TooltipIconButton>
      </ActionBarPrimitive.Edit>
    </ActionBarPrimitive.Root>
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
  return (
    <MessagePrimitive.Root
      data-slot="aui_user-message-root"
      data-role="user"
      className="grid animate-in grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [&:where(>*)]:col-start-2"
    >
      <UserMessageAttachments />

      <div className="relative col-start-2 min-w-0">
        <div className="aui-user-message-content peer rounded-xl bg-muted px-4 py-2 text-foreground empty:hidden">
          <MessagePrimitive.Parts
            components={{ ...USER_PARTS, File: UserFilePart, Image: UserImagePart }}
          />
        </div>
        <div className="absolute start-0 top-1/2 -translate-x-full -translate-y-1/2 pe-2 peer-empty:hidden rtl:translate-x-full">
          <UserActionBar />
        </div>
      </div>

      <BranchPicker className="col-span-full col-start-1 row-start-3 justify-end" />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  const { t } = useTranslation();
  return (
    <MessagePrimitive.Root
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative -mb-7.5 animate-in pb-7.5 duration-150 fade-in slide-in-from-bottom-1 motion-reduce:animate-none [contain-intrinsic-size:auto_200px] [content-visibility:auto]"
    >
      <div
        data-slot="aui_assistant-message-content"
        className="px-2 leading-relaxed text-foreground wrap-break-word"
      >
        <MessagePrimitive.GroupedParts groupBy={GROUP_BY}>
          {({ part, children }) => {
            switch (part.type) {
              case "group-chainOfThought":
                return <div data-slot="aui_chain-of-thought">{children}</div>;
              case "group-tool":
                return (
                  <ToolGroupRoot variant="ghost">
                    <ToolGroupTrigger
                      count={part.indices.length}
                      active={part.status.type === "running"}
                    />
                    <ToolGroupContent>{children}</ToolGroupContent>
                  </ToolGroupRoot>
                );
              case "group-reasoning": {
                const running = part.status.type === "running";
                return (
                  <ReasoningRoot streaming={running}>
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
                return part.toolUI ?? <ToolFallback {...part} />;
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
              case "indicator":
                return (
                  <span
                    data-slot="aui_assistant-message-indicator"
                    role="status"
                    className="animate-pulse font-sans motion-reduce:animate-none"
                    aria-label={t("chat.running")}
                  >
                    {"●"}
                  </span>
                );
              default:
                return null;
            }
          }}
        </MessagePrimitive.GroupedParts>
        <MessageError />
      </div>

      <div
        data-slot="aui_assistant-message-footer"
        className={cn("ms-2 flex items-center", ACTION_BAR_HEIGHT)}
      >
        <BranchPicker />
        <AssistantActionBar />
      </div>
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
          <div data-slot="aui_message-group" className="mb-2 flex flex-col gap-y-6 empty:hidden">
            {messages.map((message, index) => {
              const prev = messages[index - 1];
              const isHit = searchHit?.messageId === message.id;
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
                    <ThreadPrimitive.MessageByIndex index={index} components={MESSAGE_COMPONENTS} />
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
