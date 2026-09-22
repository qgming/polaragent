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
import { EnvironmentSection } from "./environment-section";
import { ArtifactsSection, ReferencesSection } from "./files-section";

/**
 * 会话面板：内容区顶栏右侧、窗口控制左边的那颗图标按钮 + 它的浮层。
 *
 * 浮层里从上到下是三块：环境信息 / 产物 / 参考。
 *
 * ## 后台作业**不在这里**（本次删除）
 *
 * 它曾经也有一块，但与对话流里的作业状态 pill **重复**：那个 pill 就在消息里，
 * 显示的是同一条作业的同一个状态（同一个 `jobsBySession`、同一份 `job-changed` 事件），
 * 而且离用户正在看的那条命令更近。两处画同一件事时，用户要先猜「该看哪个」，
 * 而其中一处（浮层）还得先点开、再找。
 * 所以这里删掉，作业只剩对话流那**一个**出处 —— 与「任务清单回到输入框上方、
 * 浮层里不留第二份」是同一条纪律。
 *
 * ## 产物 / 参考：这里只给入口与计数，列表在右侧栏
 *
 * 这两块**不再就地列出文件**（本次改动）：浮层只有 23rem 宽、看完即关，
 * 而「本次会话动过哪些文件」是需要停留、需要点开某个文件的视图。
 * 所以标题整行变成**按钮**：点一下打开右侧栏对应的那一屏（列表 + 可点开文件在其中）。
 * 计数徽标仍在，用来回答「有没有内容」这个只需要一眼的问题。
 *
 * **「任务清单」也不在这里**：它回到了输入框上方的停靠区（见 ComposerDock 的说明）。
 * 清单是「这一轮正在做什么」的实时进度，用户在盯着输入框时最需要一眼看到；
 * 藏进浮层等于每次都要主动点开。
 *
 * 没有活动会话时**不渲染按钮**（不是禁用态）：这些区块全都以「当前会话」为口径，
 * 没有会话时它们没有主语；顶栏此时显示的是「新建对话」，多一颗按钮只会让人点开一个空壳。
 *
 * 数据全部来自 store（会话、消息 parts、settings），因此徽标随会话实时变化 ——
 * 打开的是一个活视图，不是快照。
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
          「开合侧栏」，而这个按钮开的是会话自身的概览（环境/产物/参考 三块的目录）。
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
          <ArtifactsSection />
          <ReferencesSection />
        </div>
      </PopoverContent>
    </Popover>
  );
}
