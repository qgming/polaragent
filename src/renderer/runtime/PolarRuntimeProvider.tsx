import {
  type AppendMessage,
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type * as React from "react";
import { useCallback, useEffect, useMemo } from "react";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessage } from "@/shared/contracts";
import { startEventBridge } from "./event-bridge";
import { appendMessageToImages, appendMessageToText, toThreadMessage } from "./message-converter";

/** 稳定的空数组常量：zustand v5 基于 useSyncExternalStore，
 *  选择器每次返回新引用会被判定为快照变化，从而触发无限重渲染（React #185）。 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 渲染层运行时桥：把 chat-store 接入 assistant-ui 的 ExternalStoreRuntime */
export function PolarRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const messages = useChatStore((state) =>
    state.activeSessionId
      ? (state.messagesBySession[state.activeSessionId] ?? EMPTY_MESSAGES)
      : EMPTY_MESSAGES,
  );
  const isRunning = useChatStore((state) =>
    state.activeSessionId ? state.runningBySession[state.activeSessionId] === true : false,
  );

  // 主进程事件 → store reducer（卸载时取消订阅）
  useEffect(() => {
    const unsubscribe = startEventBridge((sessionId, event) => {
      useChatStore.getState().applyEvent(sessionId, event);
    });
    return unsubscribe;
  }, []);

  const onNew = useCallback(async (message: AppendMessage) => {
    const text = appendMessageToText(message);
    const images = appendMessageToImages(message);
    await useChatStore.getState().send(text, images);
  }, []);

  const onCancel = useCallback(async () => {
    await useChatStore.getState().stop();
  }, []);

  // 重新生成最后一条回复：删除其后消息并重发最后一条用户消息
  const onReload = useCallback(async () => {
    await useChatStore.getState().reload();
  }, []);

  // 图片附件：复用官方 SimpleImageAttachmentAdapter（image/*）
  const attachments = useMemo(() => new SimpleImageAttachmentAdapter(), []);

  // ChatMessage 是自定义类型，必须显式提供 convertMessage
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    onNew,
    onCancel,
    onReload,
    convertMessage: toThreadMessage,
    adapters: { attachments },
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
