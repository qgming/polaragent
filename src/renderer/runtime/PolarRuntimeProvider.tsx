import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ExternalStoreThreadListAdapter,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type * as React from "react";
import { useCallback, useEffect, useMemo } from "react";
import {
  ReplyBranchContext,
  type ReplyBranchValue,
} from "@/renderer/features/chat/reply-branch-context";
import { resolveReplies } from "@/renderer/features/chat/reply-variants";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
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
  const replySelection = useChatStore((state) =>
    state.activeSessionId === null
      ? undefined
      : state.replySelectionBySession[state.activeSessionId],
  );
  const selectReply = useChatStore((state) => state.selectReply);
  /**
   * 回复分支收敛：同一父消息下的多条助手回复只把选中的那条交给运行时。
   * 不这么做的话，重新生成后旧回复与新回复会线性并排显示（运行时的扁平列表按位置串链，
   * 不认 parentId），看起来就像重复了一条回答。
   */
  const replies = useMemo(() => resolveReplies(messages, replySelection), [messages, replySelection]);
  const branchValue = useMemo<ReplyBranchValue>(
    () => ({ branchByMessageId: replies.branchByMessageId, onSelect: selectReply }),
    [replies.branchByMessageId, selectReply],
  );
  const isRunning = useChatStore((state) =>
    state.activeSessionId ? state.runningBySession[state.activeSessionId] === true : false,
  );
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);

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

  /**
   * 会话列表适配器：把 chat-store 的 sessions 接到官方的 thread-list primitives。
   * threads 的顺序即渲染顺序，store 已按 updatedAt 降序维护，这里不再排序。
   *
   * 两点取舍（接受的功能回退，见 docs/compose/spec 的 S3）：
   * · 外部存储适配器的数据没有 lastMessageAt，官方 useThreadListGroups 因此拿不到日期，
   *   列表退化成平铺（原实现按今天/昨天/更早分组）。
   * · 官方 thread list 只为「主线程」保留 runtime，非当前会话读不到运行状态，
   *   因此运行中指示只在当前会话上有效（原实现每个会话各自显示）。
   *
   * 已归档会话仍放进 threads（官方列表不渲染 archivedThreads，放进去会彻底找不到），
   * 归档项在菜单里以同一个 Archive 入口切换，行为与原实现一致。
   */
  const threadList = useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: activeSessionId ?? undefined,
      threads: sessions.map((session) => ({
        id: session.id,
        status: "regular",
        title: session.title ?? undefined,
        custom: { archived: session.archived, updatedAt: session.updatedAt },
      })),
      onSwitchToNewThread: () => useChatStore.getState().createSession(),
      onSwitchToThread: (threadId) => useChatStore.getState().setActiveSession(threadId),
      onRename: (threadId, title) => useChatStore.getState().renameSession(threadId, title),
      onArchive: (threadId) => {
        const session = useChatStore.getState().sessions.find((item) => item.id === threadId);
        return useChatStore.getState().archiveSession(threadId, !(session?.archived ?? false));
      },
      // 官方 Delete 会立刻执行，而删会话是不可撤销的磁盘操作：先经确认框，确认后才真删
      onDelete: async (threadId) => {
        const confirmed = await useUiStore.getState().requestDeleteSession(threadId);
        if (confirmed) await useChatStore.getState().removeSession(threadId);
      },
    }),
    [sessions, activeSessionId],
  );

  const adapters = useMemo(() => ({ attachments, threadList }), [attachments, threadList]);

  // ChatMessage 是自定义类型，必须显式提供 convertMessage
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: replies.visible,
    isRunning,
    onNew,
    onCancel,
    onReload,
    convertMessage: toThreadMessage,
    adapters,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ReplyBranchContext.Provider value={branchValue}>{children}</ReplyBranchContext.Provider>
    </AssistantRuntimeProvider>
  );
}
