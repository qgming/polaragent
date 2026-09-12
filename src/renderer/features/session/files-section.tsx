"use client";

import { FileTextIcon, ImageIcon, type LucideIcon, SquarePenIcon } from "lucide-react";
import { type ReactNode, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { typePackage } from "@/renderer/components/assistant-ui/type";
import { formatTime } from "@/renderer/lib/format";
import { cn } from "@/renderer/lib/utils";
import { type FileActivity, imageAttachments, readFiles, writtenFiles } from "./session-files";
import { CopyValueButton, SectionEmpty, SessionSection } from "./session-section";
import { useActiveSessionMessages } from "./use-active-messages";

/**
 * 「产物」区块：本次会话被写 / 改过的文件。
 *
 * 只做只读列表 + 复制路径 —— 仓库里没有「在外部编辑器打开」这条通道
 * （preload 只暴露 window / sessions / chat / settings / skills / prompts / mcp / jobs / interaction），
 * 不为它新造 IPC（见交付报告）。条目数即徽标数字，内容随会话消息实时变化。
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
      files={files}
    >
      {files.length > 0 && (
        <ul className="flex flex-col px-1.5 pb-1.5">
          {files.map((file) => (
            <FileRow
              key={file.path}
              icon={FileTextIcon}
              label={file.path}
              count={file.count}
              lastAt={file.lastAt}
              copyLabel={t("sessionPanel.copyPath")}
            />
          ))}
        </ul>
      )}
    </FileSection>
  );
}

/**
 * 「参考」区块：本次会话读过的文件，加上用户发过的图片附件。
 *
 * 附件只能按 mimeType 聚合：消息里的 image part 只带 mimeType 与 dataUrl，
 * 文件名活在 Composer 的附件状态里、发送后不再保留（见 session-files.ts 的说明），
 * 所以这一行没有复制入口 —— 没有路径可复制，宁可少一个按钮也不假装有。
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
      files={files}
      extra={attachments.length}
    >
      {files.length > 0 && (
        <ul className="flex flex-col px-1.5 pb-1.5">
          {files.map((file) => (
            <FileRow
              key={file.path}
              icon={FileTextIcon}
              label={file.path}
              count={file.count}
              lastAt={file.lastAt}
              copyLabel={t("sessionPanel.copyPath")}
            />
          ))}
        </ul>
      )}
      {attachments.length > 0 && (
        <ul className="flex flex-col px-1.5 pb-1.5">
          {attachments.map((attachment) => (
            <FileRow
              key={attachment.mimeType}
              icon={ImageIcon}
              label={`${t("sessionPanel.attachment")} · ${attachment.mimeType}`}
              count={attachment.count}
              pathStyle={false}
            />
          ))}
        </ul>
      )}
    </FileSection>
  );
}

/**
 * 两块共用的外壳：徽标 = 条目数（文件 + 附件），没有可数的东西时不给徽标。
 * 空态判定把 `extra` 也算进去：只有附件、没有读过文件时不算空。
 */
function FileSection({
  slot,
  countSlot,
  icon,
  title,
  toggleLabel,
  empty,
  files,
  extra = 0,
  children,
}: {
  slot: string;
  countSlot: string;
  icon: LucideIcon;
  title: string;
  toggleLabel: string;
  empty: string;
  files: readonly FileActivity[];
  extra?: number;
  children: ReactNode;
}) {
  const total = files.length + extra;

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

/** 一行文件足迹：路径（单行截断，完整路径在 title 里）+ 次数 / 最后一次时间 + 复制 */
function FileRow({
  icon: Icon,
  label,
  count,
  lastAt,
  copyLabel,
  pathStyle = true,
}: {
  icon: LucideIcon;
  label: string;
  count?: number;
  lastAt?: number;
  copyLabel?: string;
  /** 路径行用等宽体；附件那种「图片附件 · image/png」用人话字体 */
  pathStyle?: boolean;
}) {
  return (
    <li data-slot="file-row" className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1">
      <Icon className="text-ink-4 size-3.5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          pathStyle ? typePackage : "text-[12.5px]",
          "text-ink-2 min-w-0 flex-1 truncate",
        )}
        title={label}
        dir={pathStyle ? "ltr" : undefined}
      >
        {label}
      </span>
      {count !== undefined && count > 1 && (
        <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>×{count}</span>
      )}
      {lastAt !== undefined && (
        <span className={cn(mono, "text-ink-4 shrink-0 tabular-nums")}>{formatTime(lastAt)}</span>
      )}
      {copyLabel !== undefined && <CopyValueButton value={label} label={copyLabel} />}
    </li>
  );
}
