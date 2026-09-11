"use client";

import { AlertTriangleIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "@/renderer/lib/utils";
import { field, inkButton, mono, paper } from "./surfaces";

export function EditMessage({
  value,
  discardedReplies,
  editing,
  onValueChange,
  onSave,
  onCancel,
  onStartEdit,
  cancelLabel = "Cancel",
  sendLabel = "Send",
  sendDisabled = false,
  inputLabel = "Edit your message",
  discardedLabel,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "value"
  | "discardedReplies"
  | "editing"
  | "onValueChange"
  | "onSave"
  | "onCancel"
  | "onStartEdit"
> & {
  value: string;
  discardedReplies: number;
  editing: boolean;
  onValueChange?: (value: string) => void;
  onSave?: () => void;
  onCancel?: () => void;
  onStartEdit?: () => void;
  /** 按钮文案；缺省为英文原值。调用侧接 i18n 用（本目录只有这一处消费者） */
  cancelLabel?: string;
  sendLabel?: string;
  /** 空文本时禁用发送；缺省不禁用 */
  sendDisabled?: boolean;
  /** 文本框的无障碍标签；缺省为英文原值 */
  inputLabel?: string;
  /** 丢弃提示文案；缺省为英文原值 */
  discardedLabel?: (count: number) => string;
}) {
  if (!editing) {
    return (
      <div
        data-slot="edit-message"
        className={cn("flex w-full max-w-sm justify-end", className)}
        {...props}
      >
        <button
          type="button"
          onClick={onStartEdit}
          className={cn(
            field,
            "hover:bg-foreground/[0.07] max-w-[85%] rounded-2xl px-3.5 py-2.5 text-start text-[13.5px] transition-colors",
          )}
        >
          {value}
        </button>
      </div>
    );
  }

  return (
    <div
      data-slot="edit-message"
      className={cn(paper, "flex w-full max-w-sm flex-col gap-3 rounded-[20px] p-3.5", className)}
      {...props}
    >
      <textarea
        value={value}
        onChange={(event) => onValueChange?.(event.target.value)}
        rows={2}
        aria-label={inputLabel}
        className={cn(
          field,
          "text-foreground/90 focus-visible:ring-foreground/20 resize-none rounded-xl px-3 py-2.5 text-[13.5px] leading-relaxed outline-none focus-visible:ring-1",
        )}
      />

      {discardedReplies > 0 && (
        <div className="flex items-center gap-2 text-amber-700 dark:text-amber-400">
          <AlertTriangleIcon className="size-3.5 shrink-0" />
          <span className={cn(mono, "tabular-nums")}>
            {discardedLabel
              ? discardedLabel(discardedReplies)
              : `sending discards ${discardedReplies} ${discardedReplies === 1 ? "reply" : "replies"}`}
          </span>
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="text-foreground/55 hover:bg-foreground/[0.06] hover:text-foreground/90 h-8 rounded-full px-3.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96]"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={sendDisabled}
          className={cn(
            inkButton,
            "flex h-8 items-center rounded-full px-3.5 text-xs font-medium disabled:pointer-events-none disabled:opacity-40",
          )}
        >
          {sendLabel}
        </button>
      </div>
    </div>
  );
}
