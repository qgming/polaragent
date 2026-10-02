// 用户消息里的附件卡片。
//
// 四种形态共用一个组件，因为用户看到的应该是「我贴了一个东西」，而不是四套不同的 UI：
//   · 图片：缩略图（可点开放大）+ 名字
//   · 视频：首帧 + 播放角标 + 时长 + 抽帧数 —— 抽帧数必须显示出来，否则用户会以为
//     模型看的是整段视频；事实上模型只看到那几帧
//   · 文本：图标 + 名字 + 行数（被截断时明说）
//   · 其他文件：图标 + 名字 + 大小
//
// 点击行为分两种：图片是**就地放大**（数据就在手上），其余一律**交给系统默认程序打开**
// （用真实路径）。不在应用里造一个视频播放器 —— 那要处理解码、音轨、字幕，
// 而系统播放器已经都做好了。

import { AlertTriangle, FileText, ImageOff, Play } from "lucide-react";
import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { getMimeTypeIcon } from "@/renderer/components/assistant-ui/elements/file";
import { ImagePreview, ImageZoom } from "@/renderer/components/assistant-ui/elements/image";
import { formatBytes, formatDuration } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import type { AttachmentPart } from "@/shared/contracts/attachment";

/** 缩略图方框尺寸 */
const TILE = "size-16 shrink-0 rounded-[12px]";

/** 打开一个落盘路径（失败只在控制台留痕：用户已经点了，再弹错也帮不上忙） */
function openPath(path: string | undefined): void {
  if (path === undefined || path === "") return;
  void window.oint.app
    .openPath(path)
    .then((result) => {
      if (!result.ok) console.warn(`打开附件失败：${result.reason}`);
    })
    .catch((error: unknown) => console.warn(`打开附件失败：${String(error)}`));
}

/** 缩略图区：有帧就画图，没有就画按类型选的图标 */
const AttachmentTile: FC<{ part: AttachmentPart }> = ({ part }) => {
  const frame = part.frames?.[0];
  if (frame === undefined) {
    const Icon =
      part.kind === "image"
        ? ImageOff
        : part.kind === "file"
          ? getMimeTypeIcon(part.mimeType)
          : FileText;
    return (
      <div className={cn(TILE, "bg-muted/60 grid place-items-center")} data-slot="attachment-icon">
        <Icon className="text-ink-3 size-5" aria-hidden />
      </div>
    );
  }
  return (
    <div className={cn(TILE, "bg-muted relative overflow-hidden")} data-slot="attachment-thumb">
      <ImagePreview
        src={frame.dataUrl}
        alt={part.name}
        containerClassName="size-full min-h-0"
        className="size-full object-cover"
      />
      {part.kind === "video" && (
        <div
          data-slot="attachment-play"
          className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25"
        >
          <Play className="size-5 fill-white text-white" aria-hidden />
        </div>
      )}
    </div>
  );
};

export const AttachmentCard: FC<{ part: AttachmentPart }> = ({ part }) => {
  const { t } = useTranslation();
  const frame = part.frames?.[0];
  const openable = part.path !== undefined && part.path !== "";

  /** 名字之外，用户真正想知道的那几个读数 */
  const meta: string[] = [];
  if (part.kind === "video" && part.durationSeconds !== undefined) {
    meta.push(formatDuration(part.durationSeconds * 1000));
  }
  if (part.kind === "video" && part.frameCount !== undefined) {
    meta.push(t("chat.attachmentFrames", { count: part.frameCount }));
  }
  if (part.kind === "text" && part.totalLines !== undefined) {
    meta.push(t("chat.attachmentLines", { count: part.totalLines }));
  }
  if (part.size > 0) meta.push(formatBytes(part.size));
  if (part.kind === "image" && part.downscaled === true) meta.push(t("chat.attachmentDownscaled"));
  if (part.textTruncated === true) meta.push(t("chat.attachmentTruncated"));

  const cardClass = cn(
    "border-border/70 bg-background/60 flex max-w-96 items-center gap-2.5 rounded-[14px] border p-1.5 text-start",
  );

  const body = (
    <>
      <AttachmentTile part={part} />
      <div className="flex min-w-0 flex-col gap-0.5 pe-1.5">
        <span className="truncate text-[13px] leading-tight font-medium">{part.name}</span>
        {meta.length > 0 && (
          <span className="text-ink-3 truncate text-[11.5px]">{meta.join(" · ")}</span>
        )}
        {!openable && (
          <span className="text-ink-4 flex items-center gap-1 text-[11px]">
            <AlertTriangle className="size-3" aria-hidden />
            {t("chat.attachmentPending")}
          </span>
        )}
      </div>
    </>
  );

  /**
   * 图片：整张卡片由 `ImageZoom` 接管（点开看大图）。
   *
   * 数据就在 frames 里，不必再读盘 —— 落盘的是原图，这里显示的是发给模型的那一版
   * （降采样过就显示降采样版，卡片上会标「已压缩」）。
   */
  if (part.kind === "image" && frame !== undefined) {
    return (
      <ImageZoom src={frame.dataUrl} alt={part.name}>
        <div data-slot="attachment-card" data-kind={part.kind} className={cardClass}>
          {body}
        </div>
      </ImageZoom>
    );
  }

  /**
   * 还没有落盘路径（乐观消息刚画出来的那一瞬）：不是按钮，也不能假装能点。
   * 用 div 而不是禁用按钮 —— 禁用按钮会从 Tab 序列里消失，而这里本来就没有动作。
   */
  if (!openable) {
    return (
      <div
        data-slot="attachment-card"
        data-kind={part.kind}
        className={cardClass}
        title={t("chat.attachmentPending")}
      >
        {body}
      </div>
    );
  }

  /**
   * 其余一律交给系统默认程序打开。
   *
   * 用真 `<button>` 而不是 `div role="button"`：键盘可达、焦点样式、回车/空格语义都是白拿的，
   * 而手写 role + tabIndex + onKeyDown 三件套正是无障碍审计最容易漏的地方。
   */
  return (
    <button
      type="button"
      data-slot="attachment-card"
      data-kind={part.kind}
      className={cn(cardClass, "cursor-pointer transition-colors hover:bg-background/90")}
      title={part.path}
      onClick={() => openPath(part.path)}
    >
      {body}
    </button>
  );
};
