import { AlertTriangleIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mono } from "@/renderer/components/assistant-ui/elements/surfaces";
import { Button } from "@/renderer/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/renderer/components/ui/dialog";
import { Textarea } from "@/renderer/components/ui/textarea";
import { cn } from "@/renderer/lib/utils";
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
 * 自建表单而不是复用 `elements/edit-message`：那个元素的形态是「气泡**就地**变成小编辑器」
 * 的内联控件（自带 paper 卡、20px 圆角、max-w-sm 与胶囊按钮），塞进 Dialog 会变成卡片套卡片，
 * 且圆角与按钮都不在设计契约里（dialog 12px、control 8px）。这里改用 Dialog 的既有骨架
 * （Header / 内容 / Footer + Button、Textarea），与侧栏删除确认、设置模态同构。
 *
 * 丢弃提示的数字来自真实语义：发送会回退到这条消息的父条目，
 * 因此它之后的助手回复都不再显示 —— 与列表即将截断掉的部分一致。
 */
export function EditMessageDialog() {
  const { t } = useTranslation();
  const editingId = useUiStore((s) => s.editingMessageId);
  const close = useUiStore((s) => s.closeEditMessage);
  const sessionId = useChatStore((s) => s.activeSessionId);
  const messages = useChatStore((s) =>
    s.activeSessionId === null ? undefined : s.messagesBySession[s.activeSessionId],
  );
  const [value, setValue] = useState("");
  const seededRef = useRef<string | null>(null);

  const index = messages?.findIndex((m) => m.id === editingId) ?? -1;
  const discardedReplies =
    index >= 0 ? (messages?.slice(index + 1).filter((m) => m.role === "assistant").length ?? 0) : 0;

  /**
   * 打开或换目标时用原文播种一次；关闭时清空，避免下次打开闪一帧旧文本。
   *
   * 只在 `editingId` 变化时播种，**不能**改成依赖 `messages`：它每次 store 更新都会换一个新数组，
   * 那样流式事件或翻页一到，就会把用户正在打的字重置回原文。
   */
  useEffect(() => {
    if (editingId === null) {
      seededRef.current = null;
      setValue("");
      return;
    }
    if (seededRef.current === editingId) return;
    seededRef.current = editingId;
    const list =
      sessionId === null ? undefined : useChatStore.getState().messagesBySession[sessionId];
    setValue(messageText(list?.find((message) => message.id === editingId)));
  }, [editingId, sessionId]);

  /**
   * 目标已不在当前会话时收起模态：编辑期间切走会话（Ctrl+K 打开搜索、Ctrl+N 新建对话）
   * 会让 `editUserMessage` 找不到目标而静默返回，留在屏幕上的模态就变成了一个点了没反应的死表单。
   * 只在该会话的消息已加载（messages 有值）时判定，避免加载途中把模态误关。
   */
  useEffect(() => {
    if (editingId === null || messages === undefined) return;
    if (index < 0) close();
  }, [editingId, messages, index, close]);

  const text = value.trim();

  const submit = () => {
    const id = editingId;
    // 空文本不该提交：按钮已禁用，这里只是第二道闸（回车/外部触发）
    if (id === null || text === "") return;
    close();
    void useChatStore.getState().editUserMessage(id, text);
  };

  /** Enter 保存、Shift+Enter 换行：与 Composer、设置里的「发送方式」同一口径 */
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // 中文输入法组合期间不响应：此时的 Enter 是上屏，不是提交
    if (event.nativeEvent.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  };

  return (
    <Dialog
      open={editingId !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* rounded-xl：DialogContent 基类是 rounded-lg(10px)，dialog 档位取 12px */}
      <DialogContent className="rounded-xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("chat.editMessage")}</DialogTitle>
          <DialogDescription>{t("chat.editMessageDesc")}</DialogDescription>
        </DialogHeader>

        <Textarea
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          aria-label={t("chat.editMessage")}
          className="resize-none"
        />

        <div className="flex items-center gap-3">
          {discardedReplies > 0 && (
            <span className="flex min-w-0 items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangleIcon className="size-3.5 shrink-0" />
              <span className={cn(mono, "truncate tabular-nums")}>
                {t("chat.editDiscards", { count: discardedReplies })}
              </span>
            </span>
          )}
          <span className={cn(mono, "text-muted-foreground ms-auto shrink-0")}>
            {t("chat.editSubmitHint")}
          </span>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={text === ""}>
            {t("chat.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
