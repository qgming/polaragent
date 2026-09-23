"use client";

import { Maximize2Icon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { cn } from "@/renderer/lib/utils";

/**
 * 图片查看器：会话里的一张工具图片，点缩略图**在同一个窗口里放大看**。
 *
 * ## 为什么不是新窗口 / 系统看图程序
 *
 * 工具详情里的图（`read_image` 读的文件、`browser_screenshot` 截的页面）是**对话的一部分**：
 * 用户看它的时候正在读上下文，弹到别处会把这个上下文断掉。而它又常常小到看不清
 * （手机视口截图、带缩略文字的界面截图、需要数像素的布局问题），所以「点一下看大图」
 * 是刚需，且必须能一键回到对话 —— 这就是本组件存在的全部理由。
 *
 * ## 形态：对齐设置模态，但更大
 *
 * 外壳与设置模态同一个 Dialog（同样的圆角、边框、遮罩与 Esc / 点遮罩关闭），
 * 尺寸取「比设置模态大一档」（1280×860 上限 vs 880×640）：设置是表单，字要大；
 * 这里是一张图，**像素越多越好**，所以把窗口能给的空间几乎全部留给图。
 *
 * ## 刻意只有大图 + 关闭
 *
 * 没有缩放条、旋转、下载、复制：那些是「图片编辑器的功能」。这里的动作只有一个 ——
 * 看清楚。真要看细节，用户会去开原文件或截图工具，而不是在一个对话内嵌的查看器里
 * 做图片处理。（要加功能时先问一句：这个动作是不是「看清」的一部分？）
 */
export function ImageViewer({
  open,
  onOpenChange,
  src,
  alt,
  title,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `data:` 或 blob 地址；CSP 只放行这两种（见 main/app/window.ts） */
  src: string;
  /** 无障碍名称，同时是图片加载失败时浏览器显示的替代文本 */
  alt: string;
  /** 标题栏之外的一句说明（尺寸 / 路径）；缺省时只念 alt */
  title?: string;
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/*
        尺寸：1280×860 上限，同时受窗口限制（94vw / 92vh）——
        小窗口下不会溢出，大屏上比设置模态大一圈。
        `sm:max-w-[94vw]` 必须显式给：DialogContent 自带的 `sm:max-w-lg` 优先级更高，
        不给的话宽屏下会被压回 512px —— 一张截图在那上面根本看不清。
      */}
      <DialogContent className="flex h-[min(860px,92vh)] w-[min(1280px,94vw)] items-center justify-center gap-0 overflow-hidden rounded-xl p-3 sm:max-w-[94vw]">
        {/* 标题与说明只给辅助技术：这里视觉上的主体就是那张图本身 */}
        <DialogTitle className="sr-only">{title ?? alt}</DialogTitle>
        <DialogDescription className="sr-only">{alt}</DialogDescription>
        <img
          data-slot="image-viewer-content"
          src={src}
          alt={alt}
          className="fade-in zoom-in-95 animate-in max-h-full max-w-full object-contain duration-200"
        />
      </DialogContent>
    </Dialog>
  );
}

/**
 * 详情里的**缩略图**：点它打开 ImageViewer。
 *
 * 为什么必须是显式的 button 而不是给 <img> 挂 onClick：
 * 键盘用户（Tab + Enter）与辅助技术要能「点」到它，而 <img onClick> 两样都拿不到。
 *
 * 右上角那枚小徽标**常驻可见**（不是 hover 才出现）：它是「这张图能点开」的唯一提示，
 * 而触屏与触控板上根本没有 hover 这个状态（同一条理由见 RightSidebar 标签上的 ×）。
 */
export function ImageThumb({
  src,
  alt,
  onClick,
  className,
  imgClassName,
}: {
  src: string;
  alt: string;
  onClick: () => void;
  className?: string;
  imgClassName?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t("tools.imageOpen")}
      title={t("tools.imageOpen")}
      className={cn(
        "group border-border/60 bg-foreground/[0.03] relative block w-full cursor-zoom-in overflow-hidden rounded-lg border",
        "focus-visible:ring-1 focus-visible:ring-foreground/30 focus-visible:outline-none",
        className,
      )}
    >
      <img
        src={src}
        alt={alt}
        className={cn("mx-auto block h-auto max-h-56 w-auto max-w-full object-contain", imgClassName)}
      />
      <span
        className={cn(
          "bg-background/85 text-ink-3 border-border/60 pointer-events-none absolute end-1.5 top-1.5",
          "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]",
          "opacity-80 transition-opacity group-hover:opacity-100",
        )}
      >
        <Maximize2Icon className="size-3" aria-hidden="true" />
        {t("tools.imageOpen")}
      </span>
    </button>
  );
}

/**
 * 缩略图 + 查看器的组合（会话里图片详情的标准用法）。
 *
 * 两件事绑在一起是为了让调用方**不可能只做一半**：只渲染缩略图而没有查看器，
 * 用户点上去什么都不会发生；只渲染查看器而没有缩略图，那张图在对话里根本看不见。
 * 状态（开 / 关）也留在这里，调用方不必各自持有一个 boolean。
 */
export function ImagePreview({
  src,
  alt,
  className,
  imgClassName,
  title,
}: {
  src: string;
  alt: string;
  className?: string;
  imgClassName?: string;
  title?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ImageThumb
        src={src}
        alt={alt}
        onClick={() => setOpen(true)}
        {...(className === undefined ? {} : { className })}
        {...(imgClassName === undefined ? {} : { imgClassName })}
      />
      <ImageViewer
        open={open}
        onOpenChange={setOpen}
        src={src}
        alt={alt}
        {...(title === undefined ? {} : { title })}
      />
    </>
  );
}
