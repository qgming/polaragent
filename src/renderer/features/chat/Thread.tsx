import { MessagePrimitive, ThreadPrimitive, useAuiState } from "@assistant-ui/react";
import { Fragment, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  ApprovalCard,
  type ApprovalCardRequest,
  DaySeparator,
  isSameDay,
  MarkdownText,
  MessageActionBar,
  Reasoning,
  ToolFallback,
  ToolGroup,
} from "@/renderer/components/assistant-ui";
import type { SessionSearchHit } from "@/renderer/features/search";
import { cn } from "@/renderer/lib/utils";
import type { ApprovalDecision } from "@/shared/contracts/approval";

// 助手消息的 part 渲染配置：正文走 Markdown，推理/工具调用各自折叠
const ASSISTANT_PARTS = {
  Text: MarkdownText,
  Reasoning,
  ToolGroup,
  tools: { Fallback: ToolFallback },
} satisfies MessagePrimitive.Parts.Props["components"];

// 用户消息气泡内不做 Markdown 解析，纯文本保留换行
const USER_PARTS = {
  Text: ({ text }: { text: string }) => (
    <p className="whitespace-pre-wrap leading-relaxed">{text}</p>
  ),
} satisfies MessagePrimitive.Parts.Props["components"];

function UserMessage() {
  return (
    <MessagePrimitive.Root className="group flex flex-col items-end gap-1.5 py-1.5">
      {/* 用户消息：右侧气泡，document 圆角，最大 80% 宽 */}
      <div className="max-w-[80%] rounded-sm bg-secondary px-3 py-2 text-sm">
        <MessagePrimitive.Parts components={USER_PARTS} />
      </div>
      <MessageActionBar />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="group py-1.5">
      {/* 助手消息：左对齐无气泡，印刷文档感，宽度受 --layout-thread-max-width 约束 */}
      <MessagePrimitive.Parts components={ASSISTANT_PARTS} />
      <MessageActionBar />
    </MessagePrimitive.Root>
  );
}

// ThreadPrimitive.MessageByIndex 的 components 配置（components 模式自带 message scope）
const MESSAGE_COMPONENTS = {
  UserMessage,
  AssistantMessage,
};

interface ThreadViewProps {
  /** 待审批项（来自并行车道的 chat-store）；渲染在消息流尾部 */
  approvals?: ApprovalCardRequest[];
  onResolve?: (id: string, decision: ApprovalDecision, note?: string) => void;
  /** 会话内搜索的当前命中：定位并高亮对应消息（B8） */
  searchHit?: SessionSearchHit | null;
}

/**
 * 对话线程（B1/B2/B3）：ThreadPrimitive.Root/Viewport + 日期分隔 + 消息渲染。
 * 消息列表自行遍历（thread scope 读 s.thread.messages），在跨天处插入日期分隔，
 * 再以 ThreadPrimitive.MessageByIndex 渲染单条（其内部自带 message scope）。
 */
export function ThreadView({ approvals = [], onResolve, searchHit = null }: ThreadViewProps) {
  const { t } = useTranslation();
  const messages = useAuiState((s) => s.thread.messages);
  const viewportRef = useRef<HTMLDivElement>(null);

  // 命中键：消息 id + 全局序号。流式更新不会改变键，避免反复滚动；
  // 同一消息内切换命中时键变化，需要重新定位
  const hitKey = searchHit === null ? null : `${searchHit.messageId}#${searchHit.globalIndex}`;

  // 命中变化时把对应消息滚到视口中心；reduced-motion 下用即时滚动（B8 ③ 尊重减弱动效）
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
    <ThreadPrimitive.Root className="flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport
        ref={viewportRef}
        className="app-scrollbar min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto w-full max-w-[var(--layout-thread-max-width)] px-4 py-4">
          {messages.map((message, index) => {
            const prev = messages[index - 1];
            const isHit = searchHit?.messageId === message.id;
            return (
              <Fragment key={message.id}>
                {prev !== undefined && !isSameDay(prev.createdAt, message.createdAt) && (
                  <DaySeparator date={message.createdAt} />
                )}
                {/* wrapper 承载命中锚点 data-message-id 与高亮；-mx/px 恒定，切换高亮不引起排版跳动 */}
                <div
                  data-message-id={message.id}
                  data-search-hit={isHit ? "true" : undefined}
                  className={cn(
                    "-mx-2 relative rounded-sm px-2 transition-colors motion-reduce:transition-none",
                    isHit &&
                      "bg-brand-muted/40 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:rounded-full before:bg-brand",
                  )}
                >
                  {isHit && searchHit !== null && (
                    // 文字级逐词高亮成本高（MarkdownText 内部渲染），折中为消息级标注当前位置
                    <div className="pt-1 font-mono text-[11px] text-brand-text tabular-nums">
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
              <div className="flex flex-col items-center gap-2 py-24 text-center">
                {/* B1 空态：display 衬线标题 + 副标题 */}
                <h2 className="font-display text-2xl" style={{ fontFamily: "var(--font-display)" }}>
                  {t("chat.welcome")}
                </h2>
                <p className="text-sm text-muted-foreground">{t("chat.welcomeSubtitle")}</p>
              </div>
            </ThreadPrimitive.Empty>
          )}
          {/* 审批卡插槽：设计稿 B5 为「工具调用位置」就近渲染；converter 映射工具 part 后
              可改为按消息锚定，此处按 store 提供的 pendingApprovals 统一渲染在流尾 */}
          {approvals.length > 0 && (
            <div className="space-y-2 pt-2">
              {approvals.map((request) => (
                <ApprovalCard
                  key={request.id}
                  request={request}
                  onDecide={(decision, note) => onResolve?.(request.id, decision, note)}
                />
              ))}
            </div>
          )}
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
