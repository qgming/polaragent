"use client";

import { ChevronDown, ListChecks, ListOrdered, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TodoItem } from "@/renderer/components/assistant-ui/elements/todo-list";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/renderer/components/ui/tooltip";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { QueuedMessage } from "@/shared/contracts/chat";
import type { ChatMessage } from "@/shared/contracts/session";
import { isTodoFinished, latestTodo, toTodoPanelMessages } from "./TodoPanel";

/**
 * 输入框上方的「停靠区」：任务清单 + 待发送队列。
 *
 * ## 为什么在这里、而不是顶栏的会话面板里
 *
 * 这两块原本被迁到了顶栏浮层（见 SessionPanel 的说明），代价是**它们离开了视线**：
 * 任务清单是「这一轮正在做什么」的实时进度，待发送队列是「我刚敲的还没发出去」——
 * 两者都是用户在盯着输入框时最需要一眼看到的东西，藏进浮层等于每次都要主动点开。
 * DSH 的做法是把它们做成 composer 的 dock（`conversation.input.dock` 座位），
 * 直接贴在输入框上沿；本文件跟齐这个位置。
 *
 * ## 与 DSH 的形态对齐（照抄的部分）
 *
 * - **贴住输入框、共用一个外壳**：容器宽度与输入框一致、圆角只在上方（12px），
 *   下沿与输入框无缝相接 —— 读起来是「输入框长出来的一截」，而不是另开一张卡。
 * - **一行标题 + 右侧计数/进度 + 折叠箭头**；列表在展开时才渲染。
 * - **只有一条时直接显示那一行**，不给折叠头（一条待办不值得再点一次）。
 *
 * ## 刻意与 DSH 不同的两处
 *
 * 1. **任务清单与队列是两个独立区块，不是一个**。DSH 里队列是一条，任务清单是另一条
 *    座位；这里同样分开挂，是因为它们的生命周期完全不同（清单跨轮次存活，队列只在运行中
 *    存在），合成一块会出现「清单在、队列空」时整块该不该收起的歧义。
 * 2. **任务清单默认收起，队列默认展开**。清单常常有十条以上，默认铺开会把输入框推得太远；
 *    而队列是用户自己刚敲进去的、通常一两条，没有收起的理由（DSH 也只在超过一条时才给
 *    折叠头）。两者的默认值因此相反，这是刻意的。
 */

/** 状态字形：完成勾 / 进行中环 / 待开始虚线环。三档与 DSH 的 figma 画板同口径（14×14） */
function TodoGlyph({ status }: { status: TodoItem["status"] }): React.JSX.Element {
  if (status === "done") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="text-emerald-500"
      >
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
        <path
          d="M10.4 4.9 6.3 9 3.6 6.3"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (status === "failed") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="text-red-600 dark:text-red-400"
      >
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
        <path d="M4.9 4.9 9.1 9.1M9.1 4.9 4.9 9.1" stroke="currentColor" strokeWidth="1.4" />
      </svg>
    );
  }
  if (status === "active") {
    // 进行中：渐变环 + CSS 旋转（缺口让它看起来在转，而不是一整个圆圈）
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 14 14"
        fill="none"
        aria-hidden="true"
        className="animate-spin text-blue-500 [animation-duration:1s] motion-reduce:animate-none dark:text-blue-400"
      >
        <circle
          cx="7"
          cy="7"
          r="6.4"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeDasharray="28 12"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden="true"
      className="text-ink-4"
    >
      <circle
        cx="7"
        cy="7"
        r="6.4"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeDasharray="2.4 2.4"
      />
    </svg>
  );
}

/**
 * 停靠区容器：**外轮廓由它一处画**，里面每一块只是它的一段。
 *
 * ## 宽度：输入框的 90%，居中
 *
 * 不与输入框同宽，理由与圆角有关：输入框是 `rounded-[24px]` —— 一个 24px 的圆角在**上沿**
 * 也占了 24px 的横向空间。停靠区若与它左右齐平、下沿敞开直接接上去，那两处圆弧与停靠区的
 * 直边之间会留出两个小缺口（截图里能看出来）。收窄并居中之后，停靠区的左右边缘落在输入框
 * 上沿的**直线段**之内，缺口不存在了，视觉上也自然读成「浮在输入框上方的一小块」。
 *
 * 比例是 90%（用户定的）：左右各留 5%，两侧各约 34px —— 比 24px 的圆角宽出一档，
 * 所以即使窗口更窄、圆角占比变大，也仍然落在直线段上。
 *
 * 因为不再贴边，下沿也就不能敞开：四角都给圆角（`rounded-xl`），
 * 并与输入框之间留一条 6px 的缝 —— 缝是刻意的，让两层各自成立。
 *
 * 里面每一块只是它的一段，边框与圆角属于容器：
 *   · `empty:hidden` → 两块都返回 null 时容器整个消失（不给输入框上方留一条空壳）；
 *   · 块之间的分隔线由每块自己声明（见 DockSection 的 divided）。
 */
export function ComposerDock({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div
      data-slot="composer-dock"
      className={cn(
        // 90% 宽、居中：左右各留 5%，落在输入框圆角之外
        "mx-auto mb-1.5 w-[90%]",
        "border border-border/60 rounded-xl",
        "bg-[var(--composer-bg,var(--card))] dark:bg-popover",
        "empty:hidden",
      )}
    >
      {children}
    </div>
  );
}

/**
 * 停靠区里的一段。
 *
 * `divided` = 「我上面还有一段」，于是自带一条上分隔线。由调用方按顺序给
 *（第一段不给，其余都给），因为「我是第几段」只有 Composer 知道 ——
 * 让每段自己去问「我是不是第一个」需要读 DOM 或传索引，都不如直接说清楚。
 */
function DockSection({
  slot,
  divided,
  children,
}: {
  /** 探针与接线测试靠它定位（真实像素只有 getBoundingClientRect 说了算） */
  slot: "composer-dock-todo" | "composer-dock-queue";
  /** 上面还有别的段 → 画一条上分隔线 */
  divided: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div data-slot={slot} className={cn(divided && "border-t border-border/60")}>
      {children}
    </div>
  );
}

/** 折叠箭头：收起朝上、展开朝下（与 DSH 一致 —— 点它是「摊开来看」） */
function DockChevron({ expanded }: { expanded: boolean }): React.JSX.Element {
  return (
    <ChevronDown
      className={cn(
        "text-ink-4 size-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none",
        !expanded && "rotate-180",
      )}
      aria-hidden="true"
    />
  );
}

/**
 * 任务清单停靠块。
 *
 * 取数用 `latestTodo`（与右栏会话面板同一份纯逻辑）：那条路径已经约定好「优先 details、
 * 解析不出来就退到工具参数」以及逐项校验，这里不另算一份清单。
 *
 * **全部完成时整块消失**（用户明确要求）。任务清单回答的是「还剩什么要做」，
 * 全部勾掉之后它就没有内容了 —— 留在输入框上方只是白占一行高度。
 * 判据用 `isTodoFinished`（与右栏面板同一个函数）：至少有一条、且每条都是 done。
 *
 * 为什么空清单不算收尾：`todos: []` 是合法的「清空」调用（内核提示词也把它当作一种收尾写法），
 * 但它没有「做完」的语义 —— 当作收尾是对的（没有内容可显示），只是不该被读成「任务完成」。
 * 这两种情况在这里的处置相同（都不渲染），差别体现在右栏面板的文案上。
 */
export function TodoDock(): React.JSX.Element | null {
  const { t } = useTranslation();
  const messages = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.messagesBySession[s.activeSessionId],
  );
  const [expanded, setExpanded] = useState(false);

  // 与右栏面板同一条取数路径（见 TodoPanel 的 latestTodo / toTodoPanelMessages）
  const todo = latestTodoFromStore(messages);
  // 全部完成（或清单为空）→ 整块消失，不在输入框上方留一行「已完成」
  if (todo === null || todo.items.length === 0 || isTodoFinished(todo)) return null;

  const done = todo.items.filter((item) => item.status === "done").length;
  const total = todo.items.length;

  return (
    <DockSection slot="composer-dock-todo" divided={false}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={t("sessionPanel.tasksToggle")}
        onClick={() => setExpanded((value) => !value)}
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-1.5 text-start outline-none transition-colors",
          "hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-foreground/20",
        )}
      >
        {/* 图标不再区分「已完成」色：全部完成时整块已经不渲染了（见上面的早退） */}
        <ListChecks className="text-ink-3 size-3.5 shrink-0" />
        <span className="text-foreground shrink-0 text-[13px] font-medium">
          {t("sessionPanel.tasks")}
        </span>
        <span className={cn(typeEyebrow, "text-ink-4 min-w-0 flex-1 truncate tabular-nums")}>
          {t("chat.dockTodoProgress", { done, total })}
        </span>
        <DockChevron expanded={expanded} />
      </button>
      {expanded && (
        // 清单一长就内部滚动，不把输入框一路推下去（上限与 DSH 的 180px 同口径）
        <ul className="app-scrollbar flex max-h-45 flex-col gap-2 overflow-y-auto px-3 pt-0.5 pb-2">
          {todo.items.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2.5">
              <span className="grid size-4 shrink-0 place-items-center">
                <TodoGlyph status={item.status} />
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px] leading-5",
                  item.status === "done" && "text-ink-4 line-through decoration-[1.5px]",
                  item.status === "active" && "text-foreground",
                  item.status === "pending" && "text-ink-3",
                  item.status === "failed" && "text-red-600 dark:text-red-400",
                )}
                title={item.text}
              >
                {item.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DockSection>
  );
}

/** 从 store 的消息取最新清单；与右栏 TodoPanel 共用同一套解析（见该文件的说明） */
function latestTodoFromStore(
  messages: readonly ChatMessage[] | undefined,
): { items: TodoItem[] } | null {
  if (messages === undefined) return null;
  return latestTodo(toTodoPanelMessages(messages));
}

/**
 * 待发送队列停靠块。
 *
 * 与 DSH 的 QueueDock 对齐的部分：**一行标题（图标 + 条数 + 折叠箭头）**，
 * 条数为 1 时不给折叠头、直接显示那一行；每条右侧有「移除」。
 *
 * 这里**没有**「编辑」：DSH 的编辑走 `updateQueue(itemId, {kind:"edit"})`，而内核的
 * lane 只提供 `cancelQueued`（取消），没有「改写队列项正文」的原语 —— 要支持编辑就得
 * 「取消 + 重新入队」，那会让这条消息在 lane 里的位置跑到队尾（用户看到的是它掉到最后
 * 去了）。宁可不做，也不做一个顺序会变的编辑。旧实现这里是禁用按钮 + 「功能未开放」
 * 的提示，那个占位现在删掉了：一个永远点不动的铅笔图标比没有更让人困惑。
 */
export function QueueDock({
  items,
}: {
  items: readonly QueuedMessage[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);

  if (items.length === 0) return null;

  /** 一条时直接铺开（不给折叠头），多条时由折叠头控制 */
  const single = items.length === 1;
  const listVisible = single || !collapsed;

  return (
    <DockSection slot="composer-dock-queue" divided>
      {!single && (
        <button
          type="button"
          aria-expanded={listVisible}
          onClick={() => setCollapsed((value) => !value)}
          className={cn(
            "flex w-full items-center gap-2.5 px-3 py-1.5 text-start outline-none transition-colors",
            "hover:bg-foreground/[0.03] focus-visible:ring-1 focus-visible:ring-foreground/20",
          )}
        >
          <ListOrdered className="text-ink-3 size-3.5 shrink-0" />
          <span className="text-foreground shrink-0 text-[13px] font-medium">
            {t("chat.queueCount", { count: items.length })}
          </span>
          <span className="min-w-0 flex-1" />
          <DockChevron expanded={listVisible} />
        </button>
      )}
      {listVisible && (
        <ul className="app-scrollbar flex max-h-45 flex-col overflow-y-auto">
          {items.map((item) => (
            <QueueRow key={item.id} item={item} showIcon={single} />
          ))}
        </ul>
      )}
    </DockSection>
  );
}

/** 队列里的一行：序号/图标 + 正文 + 模式标记 + 移除 */
function QueueRow({
  item,
  showIcon,
}: {
  item: QueuedMessage;
  /** 只有一条时这一行要兼任折叠头，所以补上那枚图标（与 DSH 的 single 分支同口径） */
  showIcon: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();

  return (
    <li className="group/queue flex min-w-0 items-center gap-2.5 px-3 py-1.5">
      {showIcon && <ListOrdered className="text-ink-3 size-3.5 shrink-0" />}
      <span className="text-ink-2 min-w-0 flex-1 truncate text-[13px]" title={item.text}>
        {item.text}
      </span>
      {/*
        插话 vs 排队：两者都会在当前轮跑完后发送，差别是 steer 会在**当前这一步**结束时
        就插进去。不标出来用户分不清「为什么这条先发了」。
      */}
      {item.mode === "steer" && (
        <span className={cn(typeEyebrow, "text-ink-4 shrink-0")}>{t("chat.steer")}</span>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("chat.queueRemove")}
            // hover 或键盘聚焦才显形：静止时这一行是干净的（与标签栏的 × 同一手法）
            className={cn(
              "grid size-5 shrink-0 place-items-center rounded-md opacity-0 transition-opacity",
              "group-hover/queue:opacity-100 focus-visible:opacity-100",
              "text-ink-4 hover:bg-foreground/[0.06] hover:text-foreground",
            )}
            onClick={() => void useChatStore.getState().cancelQueued(item.id)}
          >
            <X className="size-3" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t("chat.queueRemove")}</TooltipContent>
      </Tooltip>
    </li>
  );
}
