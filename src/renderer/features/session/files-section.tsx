"use client";

import {
  ChevronRightIcon,
  FileTextIcon,
  ImageIcon,
  type LucideIcon,
  SquarePenIcon,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import {
  baseNameOf,
  fileOpenTarget,
  toAbsolutePath,
  toFileUrl,
} from "@/renderer/features/chat/turn-files";
import { formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { type FileActivity, imageAttachments, readFiles, writtenFiles } from "./session-files";
import { CopyValueButton, SectionEmpty, SessionSection } from "./session-section";
import { useActiveSessionMessages } from "./use-active-messages";

/**
 * 「产物」区块：本次会话被写 / 改过的文件。
 *
 * **仍在浮层里就地展开**（本次没有把它搬去右侧栏）：这一块回答的是
 * 「这次会话动过哪些文件」——一个只需要扫一眼的清单。展开/收起都在浮层内完成，
 * 与「环境信息」那一块是同一种阅读节奏。
 *
 * 唯一进右侧栏的是**具体某个文件**：点一行即在右侧栏的文件查看器里打开它
 *（`openFilePanel`，与对话里那几张文件卡片同一套路由）。清单留在原地、
 * 内容去宽处看 —— 这既保住了浮层「一眼扫过」的定位，又不必把 23rem 宽的路径
 * 硬截成只剩尾巴。
 *
 * 数据仍走会话消息（见 session-files.ts 的三个纯函数），计数即徽标数字，
 * 内容随会话实时变化。
 */
export function ArtifactsSection() {
  const { t } = useTranslation();
  const messages = useActiveSessionMessages();
  const files = useMemo(() => writtenFiles(messages), [messages]);

  return (
    <FileSection
      slot="artifacts-panel"
      countSlot="artifacts-count"
      icon={SquarePenIcon}
      title={t("sessionPanel.artifacts")}
      toggleLabel={t("sessionPanel.artifactsToggle")}
      empty={t("sessionPanel.artifactsEmpty")}
      total={files.length}
    >
      <ul className="flex flex-col px-1.5 pb-1.5">
        {files.map((file) => (
          <FileRow key={file.path} file={file} copyLabel={t("sessionPanel.copyPath")} />
        ))}
      </ul>
    </FileSection>
  );
}

/**
 * 「参考」区块：本次会话读过的文件，加上用户发过的图片附件。
 *
 * 与产物同样是**浮层内展开**（理由见上），只有文件行会打开右侧栏查看器。
 *
 * 附件只能按 mimeType 聚合、且**不可点开**：消息里的 image part 只带 mimeType 与 dataUrl，
 * 文件名活在 Composer 的附件状态里、发送后不再保留（见 session-files.ts 的说明）——
 * 没有路径就没有可打开的东西，宁可少一个交互也不假装有。
 */
export function ReferencesSection() {
  const { t } = useTranslation();
  const messages = useActiveSessionMessages();
  const files = useMemo(() => readFiles(messages), [messages]);
  const attachments = useMemo(() => imageAttachments(messages), [messages]);

  return (
    <FileSection
      slot="references-panel"
      countSlot="references-count"
      icon={FileTextIcon}
      title={t("sessionPanel.references")}
      toggleLabel={t("sessionPanel.referencesToggle")}
      empty={t("sessionPanel.referencesEmpty")}
      total={files.length + attachments.length}
    >
      {files.length > 0 && (
        <ul className="flex flex-col px-1.5 pb-1.5">
          {files.map((file) => (
            <FileRow key={file.path} file={file} copyLabel={t("sessionPanel.copyPath")} />
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <ul className="flex flex-col px-1.5 pb-1.5">
          {attachments.map((attachment) => (
            <li
              key={attachment.mimeType}
              data-slot="reference-attachment"
              className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1"
            >
              <ImageIcon className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
              <span className="text-ink-2 min-w-0 flex-1 truncate text-[12.5px]">
                {t("sessionPanel.attachment")} · {attachment.mimeType}
              </span>
              {attachment.count > 1 && (
                <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>
                  ×{attachment.count}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </FileSection>
  );
}

/**
 * 两块共用的外壳：徽标 = 条目数，没有可数的东西时不给徽标。
 * 空态判定把附件也算进去（调用方传的 total 已经是合计）：只有附件、没读过文件时不算空。
 */
function FileSection({
  slot,
  countSlot,
  icon,
  title,
  toggleLabel,
  empty,
  total,
  children,
}: {
  slot: string;
  countSlot: string;
  icon: LucideIcon;
  title: string;
  toggleLabel: string;
  empty: string;
  total: number;
  children: ReactNode;
}) {
  return (
    <SessionSection
      slot={slot}
      icon={icon}
      title={title}
      toggleLabel={toggleLabel}
      count={total === 0 ? undefined : String(total)}
      countSlot={countSlot}
    >
      {total === 0 ? <SectionEmpty>{empty}</SectionEmpty> : children}
    </SessionSection>
  );
}

/**
 * 一行文件足迹：**整行可点，点了在右侧栏打开这个文件**。
 *
 * 行的排版沿用原来的口径（等宽路径 + 次数 + 最后一次时间 + 复制），
 * 只是把「路径」换成了可点的按钮，并在尾部加一枚箭头 —— 箭头是**去哪里的提示**：
 * 点它不会就地展开任何东西，而是把内容送到右边那一栏去。
 *
 * 路径**仍然显示原文**（不切成 basename）：这一块是「本次会话的足迹」，
 * 用户在这里认的是路径（`src/renderer/...` 这种前缀本身就是信息）；
 * 宽度不够时靠 CSS 截断，完整路径仍在 title 与无障碍名称里。
 * （侧栏那一屏是另一回事：那里一行更窄、认的是文件名。）
 */
function FileRow({ file, copyLabel }: { file: FileActivity; copyLabel: string }) {
  const { t } = useTranslation();
  const cwd = useChatStore((s) =>
    s.activeSessionId === null
      ? undefined
      : s.sessions.find((item) => item.id === s.activeSessionId)?.cwd,
  );
  const openFilePanel = useUiStore((s) => s.openFilePanel);
  const openInBrowser = useUiStore((s) => s.openInBrowser);

  /**
   * 打开这一行指向的文件。
   *
   * 相对路径要先拼上会话 cwd（工具参数里常常是 `src/foo.ts`，而查看器只认绝对路径）。
   * cwd 拿不到、且路径本身也是相对的时**不给点击**（点了必然被主进程拒），
   * 但行照常显示 —— 「这次动过这个文件」与「现在能不能打开它」是两件事。
   *
   * HTML 交给内置浏览器：应用自己的 CSP 是 `frame-src 'none'`，在查看器里内联渲染它
   * 要么被拦掉、要么得引一个 sanitize 依赖。这一条与对话里的文件卡片同源
   *（都用 turn-files 的 fileOpenTarget / toFileUrl），绝不在这里另写一份判断。
   */
  const absolute = toAbsolutePath(file.path, cwd);
  const openable = cwd !== undefined || isAbsolutePath(file.path);

  const open = () => {
    if (fileOpenTarget(file.path) === "browser") {
      openInBrowser({ url: toFileUrl(absolute), title: baseNameOf(file.path) });
      return;
    }
    openFilePanel(absolute);
  };

  return (
    <li data-slot="file-row" className="flex min-w-0 items-center gap-2 rounded-lg">
      <button
        type="button"
        aria-label={openable ? t("sessionPanel.openFile", { path: file.path }) : file.path}
        title={openable ? t("sessionPanel.openFile", { path: file.path }) : file.path}
        disabled={!openable}
        onClick={open}
        className={cn(
          "group flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-start outline-none",
          openable
            ? "hover:bg-foreground/[0.04] focus-visible:ring-1 focus-visible:ring-foreground/20"
            : "cursor-default",
        )}
      >
        <FileTextIcon className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
        <span className={cn(typePackage, "text-ink-2 min-w-0 flex-1 truncate")} dir="ltr">
          {file.path}
        </span>
        {file.count > 1 && (
          <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>×{file.count}</span>
        )}
        <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>
          {formatTime(file.lastAt)}
        </span>
        {/* 箭头是「去右侧看」的提示；静止时压得很淡，hover 才亮起来 —— 
            它是这一行的次要信息，不该和路径抢注意力 */}
        {openable && (
          <ChevronRightIcon
            className="text-ink-4 size-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
            aria-hidden="true"
          />
        )}
      </button>
      <CopyValueButton value={file.path} label={copyLabel} />
    </li>
  );
}

/** 路径是不是绝对路径；判据与 turn-files.ts 的 toAbsolutePath 同源（两个平台各一条） */
function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(path);
}
