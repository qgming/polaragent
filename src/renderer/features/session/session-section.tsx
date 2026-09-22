"use client";

import { CheckIcon, ChevronDownIcon, CopyIcon, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { collapsePanel } from "@/renderer/components/assistant-ui/elements/surfaces";
import { TooltipIconButton } from "@/renderer/components/assistant-ui/elements/tooltip-icon-button";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Badge } from "@/renderer/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/renderer/components/ui/collapsible";
import { useCopyToClipboard } from "@/renderer/hooks/use-copy-to-clipboard";
import { cn } from "@/renderer/lib/utils";

/**
 * 会话面板里的一个可折叠区块（浮层里三块共用这一个外壳：环境信息 / 产物 / 参考）。
 *
 * 与 TodoPanel 原来贴在输入框上沿的那条是同一套写法（整行可点的
 * CollapsibleTrigger + 右侧进度 + 会翻转的 chevron + collapsePanel 键帧动画），
 * 只是不再自带负外边距与圆角 —— 那两件事由 composer 的面负责，这里由浮层的面负责。
 *
 * 徽标的口径：`count` 为 undefined 时不渲染（没有可数的东西就不要摆一个「0」，
 * 空态文案已经说明了一切）；完成态用绿色系，与工具卡绿勾、作业「已退出」同一支颜色，
 * 明暗两套主题各给一个前景色。
 */

/** 计数徽标的两种语气：中性（还在进行）与完成（全部收尾） */
const COUNT_TONES = {
  neutral: "border-transparent bg-foreground/[0.07] text-ink-3",
  done: "border-emerald-500/25 bg-emerald-500/[0.08] text-emerald-600 dark:text-emerald-400",
} as const;

export interface SessionSectionProps {
  /** 根节点的 data-slot：测试与会话面板的各块都用它认人 */
  slot: string;
  icon: LucideIcon;
  title: string;
  /** 折叠按钮的无障碍名称（可见文本只有标题，动作由它补） */
  toggleLabel: string;
  /** 右侧计数徽标的文案；undefined = 不渲染徽标 */
  count?: string;
  /** 徽标自己的 data-slot（徽标文案在多块之间可能重样） */
  countSlot?: string;
  countTone?: keyof typeof COUNT_TONES;
  defaultOpen?: boolean;
  /**
   * 「有内容了就展开」：只在用户还没手动开合过时生效。
   * 待办清单就靠它实现「有清单时默认展开」——浮层一打开时内容可能还没到。
   */
  autoOpen?: boolean;
  children: ReactNode;
}

export function SessionSection({
  slot,
  icon: Icon,
  title,
  toggleLabel,
  count,
  countSlot,
  countTone = "neutral",
  defaultOpen = false,
  autoOpen = false,
  children,
}: SessionSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  /** 用户动过之后就不再自动展开（他的收起是明确的意愿，不该被后来的内容推翻） */
  const touched = useRef(false);

  useEffect(() => {
    if (autoOpen && !touched.current) setOpen(true);
  }, [autoOpen]);

  return (
    <section data-slot={slot} className="border-b border-border/50 last:border-b-0">
      <Collapsible
        open={open}
        onOpenChange={(next) => {
          touched.current = true;
          setOpen(next);
        }}
      >
        <CollapsibleTrigger
          aria-label={toggleLabel}
          className={cn(
            "flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-start outline-none transition-colors",
            "hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/20",
            typeEyebrow,
          )}
        >
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="me-auto truncate">{title}</span>
          {count !== undefined && (
            <Badge
              variant="outline"
              data-slot={countSlot}
              className={cn(
                "h-4.5 shrink-0 px-1.5 text-[10.5px] leading-none font-normal tabular-nums",
                COUNT_TONES[countTone],
              )}
            >
              {count}
            </Badge>
          )}
          <ChevronDownIcon
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform motion-reduce:transition-none",
              open && "rotate-180",
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className={cn(collapsePanel, "outline-none")}>
          {children}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

/** 区块的空态：一句话说明「这一块为什么是空的」，不留空白列表 */
export function SectionEmpty({ children }: { children: ReactNode }) {
  return (
    <p data-slot="section-empty" className="px-2.5 pt-0.5 pb-2 text-[12.5px] text-ink-4">
      {children}
    </p>
  );
}

/**
 * 复制按钮：值存在时才渲染，点完短暂切成勾。
 * 复制动作走仓库既有的 useCopyToClipboard（无 clipboard 权限时静默失败，不弹错误）。
 */
export function CopyValueButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  return (
    <TooltipIconButton
      type="button"
      tooltip={isCopied ? t("sessionPanel.copied") : label}
      aria-label={isCopied ? t("sessionPanel.copied") : label}
      onClick={() => copyToClipboard(value)}
      className="size-5 p-0 [&_svg]:size-3"
    >
      {isCopied ? <CheckIcon className="text-emerald-600 dark:text-emerald-400" /> : <CopyIcon />}
    </TooltipIconButton>
  );
}
