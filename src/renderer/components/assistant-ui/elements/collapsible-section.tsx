"use client";

import { ChevronRightIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useId } from "react";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { cn } from "@/renderer/lib/utils";
import { collapsePanel } from "./surfaces";

/**
 * 小节标题的排版：mono 眉题（typeEyebrow 那一族 —— 本仓给 section 命名的字体），
 * 字号抬到 13px、颜色提到 ink-2。
 *
 * **为什么不是 typeEyebrow 原样的 11px / ink-3**：11px 是侧栏分组、命令面板那种密排列表的
 * 档位，而这里是详情正文之上的小节标题 —— 这一屏要回答的第一件事就是「任务 / 汇报 / 执行记录
 * 各是什么」，标题得先被看见。13px 是本仓已有的字号（ComposerDock 的分区标题、RunRow 的
 * 代理名同档），不新增字号；ink-2 比原来的 ink-4 强两档（亮色底 4.8:1 → 8.1:1）。
 */
const sectionTitle = cn(typeEyebrow, "text-[13px] text-ink-2");

/** 不可折叠的小节标题。与 CollapsibleSection 的标题同一套排版，两处不会各长各的 */
export function SectionTitle({ children }: { children: ReactNode }): React.JSX.Element {
  return <h4 className={sectionTitle}>{children}</h4>;
}

/**
 * 详情里的一个小节：标题行（点哪儿都能开合）+ 可折叠的正文。
 *
 * **为什么整行都是按钮，而不是标题右边孤零零一枚箭头**：箭头只有 14px，是这一屏最小的
 * 目标；标题行整条可点，点「任务」两个字也能开合 —— 用户对「标题旁边有个箭头」的预期本来
 * 就是这样。箭头仍然留着，它表达的是**当前状态**（▸ 收起 / ▾ 展开），不是唯一的入口。
 *
 * **为什么折叠是「全有或全无」**：早先的版本按高度裁到 10 行、底缘渐隐、底部再摆一枚
 * 「展开全文」，被用户否掉了 —— 半截正文看起来像渲染坏了，而那颗按钮离标题很远，读的
 * 时候要来回找。现在：收起来只剩标题行，展开就是全文。
 *
 * **为什么默认展开**：打开面板就是来看这次委派的，内容先摆出来；收起是用户想腾地方时的
 * 动作，不是看到内容前要先迈的一道门。
 *
 * **标题语义**：标题是 h4，按钮包在 heading **里面**（`<h4><button>`），标题层级与折叠
 * 控件因此都不丢 —— 读屏按 h4 报出「任务」，按按钮报出「已展开 / 已收起」。
 *
 * **无障碍**：aria-expanded 由 Radix 给；aria-controls 显式补上（Radix 默认只在展开时
 * 给，收起态就没有了，而这里要求它一直指向内容区）；键盘可达是原生 button + 可见焦点环；
 * 动效在 prefers-reduced-motion 下由 collapsePanel / motion-reduce 关掉。
 */
export function CollapsibleSection({
  title,
  style,
  children,
}: {
  /** 小节名。既显示在标题行，也是折叠控件的读屏名（两处同名才对：听到的和看到的是同一个） */
  title: string;
  /** 字体与字号的口径由调用侧给（面板上是 --chat-font / --chat-font-size） */
  style?: CSSProperties;
  children: ReactNode;
}): React.JSX.Element {
  const contentId = useId();

  return (
    // asChild 把开合状态留在 <section> 上，而不是多套一层 div（标题层级在 DOM 里是干净的）
    <Collapsible asChild defaultOpen>
      <section className="flex flex-col gap-1.5">
        <h4>
          <CollapsibleTrigger
            aria-controls={contentId}
            className="group/trigger text-ink-2 hover:text-foreground flex w-full cursor-pointer items-center gap-1 rounded-sm py-0.5 text-start outline-none transition-colors focus-visible:ring-1 focus-visible:ring-foreground/20"
          >
            {/* 标题自己也写着墨色，所以悬停时要显式跟一下：否则整行变色时它纹丝不动 */}
            <span
              className={cn(sectionTitle, "transition-colors group-hover/trigger:text-foreground")}
            >
              {title}
            </span>
            {/* ▸ 收起 / ▾ 展开：与工具行的折叠箭头同一套（ChevronRight 转 90°） */}
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-90 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </h4>
        {/*
          正文：折叠动画（200ms 键帧）与隐藏语义由 CollapsibleContent + collapsePanel 给
          —— 与工具详情、思考块同一条口径，收起后内容会真的离开 DOM。
        */}
        <CollapsibleContent id={contentId} className={cn(collapsePanel, "outline-none")}>
          <div style={style} className="leading-relaxed">
            {children}
          </div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}
