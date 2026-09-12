"use client";

import { TableOfContentsIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { floating } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typeEyebrow } from "@/renderer/components/assistant-ui/type";
import { Button } from "@/renderer/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/renderer/components/ui/popover";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { JobPanel } from "../chat/JobPanel";
import { TodoPanel } from "../chat/TodoPanel";
import { EnvironmentSection } from "./environment-section";
import { ArtifactsSection, ReferencesSection } from "./files-section";

/**
 * 会话面板：内容区顶栏右侧、窗口控制左边的那颗图标按钮 + 它的浮层。
 *
 * 浮层里从上到下是可折叠的区块：环境信息 / 任务清单 / 后台作业 / 产物 / 参考。
 * 「任务清单」与「后台作业」就是从 Composer 上方迁过来的那两条（原 TodoPanel / JobPanel），
 * 内容与取数一字未改，只是换了容器与外壳 —— 迁移后 Composer 里不再有它们。
 *
 * 没有活动会话时**不渲染按钮**（不是禁用态）：这些区块全都以「当前会话」为口径，
 * 没有会话时它们没有主语；顶栏此时显示的是「新建对话」，多一颗按钮只会让人点开一个空壳。
 *
 * 数据全部来自 store（会话、消息 parts、jobsBySession、settings），因此徽标与列表随会话
 * 实时变化 —— 打开的是一个活视图，不是快照。
 */
export function SessionPanel() {
  const { t } = useTranslation();
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const [open, setOpen] = useState(false);

  if (activeSessionId === null) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/*
          图标按钮：无障碍名称与悬浮提示都由此给出（与相邻的窗口控制同一个写法）。
          图标取「目录/大纲」语义（TableOfContents）而不是任何 Panel* 那族：Panel* 一眼就是
          「开合侧栏」，而这个按钮开的是会话自身的概览（环境/任务/作业/产物/参考 五块的目录）。
          打开态给一层与 ghost hover 同色的底：与参考图里「点亮当前那颗」一致，
          关掉就落回普通图标按钮。
        */}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={t("sessionPanel.open")}
          aria-expanded={open}
          title={t("sessionPanel.open")}
          className={cn(open && "bg-accent text-accent-foreground dark:bg-accent/50")}
        >
          <TableOfContentsIcon className="size-4" />
        </Button>
      </PopoverTrigger>
      {/* 右对齐：按钮就在窗口右边，向左展开才不会顶出窗口；宽度与 max-h 与其它内容型浮层同口径 */}
      <PopoverContent
        align="end"
        className={cn(
          floating,
          "flex max-h-[70vh] w-[23rem] flex-col overflow-hidden rounded-2xl p-1.5",
        )}
      >
        {/* 浮层自己滚动：区块再多也不把卡片顶出窗口；滚动条走仓库既有的 app-scrollbar */}
        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto">
          {/* 浮层自己的标题：比区块标签强一档 —— 区块标题是 typeEyebrow 的 ink-3，这里压到 ink-2 */}
          <p className={cn(typeEyebrow, "px-2.5 pt-1.5 pb-1 font-medium text-ink-2")}>
            {t("sessionPanel.title")}
          </p>
          <EnvironmentSection />
          <TodoPanel />
          <JobPanel />
          <ArtifactsSection />
          <ReferencesSection />
        </div>
      </PopoverContent>
    </Popover>
  );
}
