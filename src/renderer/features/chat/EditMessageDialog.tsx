"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { EditMessage } from "@/renderer/components/assistant-ui/elements/edit-message";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/renderer/components/ui/dialog";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts/session";

/** 取用户消息里的纯文本（图片等其它 part 不参与编辑） */
function messageText(message: ChatMessage | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/**
 * 编辑用户消息的模态。
 *
 * 用官方的 `EditMessage`（elements-edit-message）：把它固定成编辑态就是「文本框 + 取消/发送
 * + 丢弃提示」那套既定形态，不必另造一套控件。它自带的气泡态（editing=false）用不上 ——
 * 我们有自己的气泡与 hover 工具栏，所以那个分支永远不渲染。
 *
 * 丢弃提示的数字来自真实语义：发送会回退到这条消息的父条目，
 * 因此它之后的助手回复都不再显示 —— 与列表即将截断掉的部分一致。
 */
export function EditMessageDialog() {
  const { t } = useTranslation();
  const editingId = useUiStore((s) => s.editingMessageId);
  const close = useUiStore((s) => s.closeEditMessage);
  const messages = useChatStore((s) =>
    s.activeSessionId === null
      ? undefined
      : s.messagesBySession[s.activeSessionId],
  );
  const [value, setValue] = useState("");

  const index = messages?.findIndex((m) => m.id === editingId) ?? -1;
  const target = index >= 0 ? messages?.[index] : undefined;
  const discardedReplies =
    index >= 0
      ? (messages?.slice(index + 1).filter((m) => m.role === "assistant").length ?? 0)
      : 0;

  // 打开或换目标时用原文重新播种；关闭时清空，避免下次打开闪一帧旧文本
  useEffect(() => {
    setValue(messageText(target));
  }, [target]);

  const submit = () => {
    const id = editingId;
    const text = value.trim();
    if (id === null || text === "") return;
    close();
    void useChatStore.getState().editUserMessage(id, text);
  };

  return (
    <Dialog
      open={editingId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chat.editMessage")}</DialogTitle>
        </DialogHeader>
        <EditMessage
          value={value}
          discardedReplies={discardedReplies}
          editing
          onValueChange={setValue}
          onSave={submit}
          onCancel={close}
          cancelLabel={t("common.cancel")}
          sendLabel={t("chat.send")}
          discardedLabel={(count) => t("chat.editDiscards", { count })}
        />
      </DialogContent>
    </Dialog>
  );
}
