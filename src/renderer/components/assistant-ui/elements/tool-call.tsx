"use client";

import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { collapsePanel, mono, ShimmerLabel, SwapLabel } from "./surfaces";

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  running: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * 展开区的内容。**必填**：这个组件不再自带兜底面板。
   *
   * 早先它有一个内置的 Request/Result 文本面板（`<p>{result}</p>`），问题有两个：
   *   1. 那个 `<p>` 没有 `whitespace-pre-wrap`，纯文本里的换行被压成空格 ——
   *      read / grep / 报错这些最需要看换行的结果全糊成一整行；
   *   2. 一旦调用方给了 detail，面板就被整体顶掉，于是「详情」与「原文」二选一，
   *      web_fetch 的正文就这么在界面上消失了。
   *
   * 现在展开区一律由调用方给（工具自己声明它该怎么显示），外层外观由这里的
   * `detail` 容器统一（见下方 render 里的 shell）。
   */
  detail: ReactNode;
  /**
   * 调用失败：整行转红、收尾标记换成红叉。
   * 必须由调用方显式传入 —— 这个组件从 part 上拿不到失败信息（aui 的 part status 只表达
   * 「跑没跑完」，「有没有报错」在本仓是 isError 这个独立字段）。
   */
  isError?: boolean;
  className?: string;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  running,
  open,
  onOpenChange,
  detail,
  isError = false,
  className,
}: ToolCallProps) {
  // 纵向间距交给父容器的 gap（与正文段落、思考块同为 12px），块自身不带到外边距
  return (
    <Collapsible
      data-slot="tool-call"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger
        className={cn(
          "group/trigger text-ink-3 hover:text-foreground flex items-center gap-2 rounded-md py-0 text-[13.5px] transition-colors outline-none",
          isError &&
            "text-red-600/85 hover:text-red-600 dark:text-red-400/85 dark:hover:text-red-400",
        )}
      >
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none" />
        <SwapLabel active={running ? 0 : 1} className="text-start">
          <ShimmerLabel active={running} className="relative inline-block leading-none">
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        {/*
          参数 chip：**没有主参数时不渲染**。
          早先无条件渲染，于是 ask_user（参数是 questions 数组、里面没有一个字符串）
          会在行上留下一枚只有 padding 的空灰胶囊 —— 看起来像个渲染 bug。
        */}
        {query !== "" && (
          <span
            className={cn(
              mono,
              "bg-foreground/[0.06] text-ink-2 min-w-0 truncate rounded-md px-1.5 py-0.5",
            )}
          >
            {query}
          </span>
        )}
        <span className="ms-auto flex w-4 items-center justify-end">
          {!running &&
            (isError ? (
              <XIcon className="fade-in zoom-in-90 animate-in size-3.5 text-red-600 duration-200 dark:text-red-400" />
            ) : (
              <CheckIcon className="fade-in zoom-in-90 animate-in size-3.5 text-emerald-500 duration-200" />
            ))}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
        {/*
          展开区：**不再套外层容器**，只给上间距。
          外壳（paper 面 + rounded-2xl）由每个详情组件自己带 —— 与 CodeDiff / TerminalBlock
          一致，那是本仓工具详情的标准外观（见那两个文件的说明）。
          早先这里套了一层 field 灰底框，而详情各自又带 paper，两层叠在一起
          （灰底框里浮着一张白卡），既多一道视觉噪声，也让各详情的外观不再统一。

          间距走 --density-gap-inner：块内条目，比块间距紧一档（舒适 12 / 紧凑 8）。
        */}
        <div className="mt-(--density-gap-inner)">{detail}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
