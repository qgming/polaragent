import {
  type AppendMessage,
  AssistantRuntimeProvider,
  type ExternalStoreThreadListAdapter,
  SimpleImageAttachmentAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type * as React from "react";
import { useCallback, useEffect, useMemo } from "react";
import { buildSlashCommands, expandSlashInput } from "@/renderer/features/chat/slash-commands";
import { resolveWorkingDir } from "@/renderer/features/chat/use-slash-commands";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts";
import { startEventBridge } from "./event-bridge";
import { appendMessageToImages, appendMessageToText, toThreadMessage } from "./message-converter";

/**
 * 发送前把斜杠命令展开成真正发给模型的内容（提示模板 → 替换占位符后的正文）。
 *
 * 为什么落在这里而不是 Composer：库的发送主路径是 ComposerPrimitive.Send → 本 provider 的
 * onNew，Composer 想拦它就得放弃 Send primitive 自己重写一遍发送；而 onNew 是**唯一的**
 * 收口，两条发送路径（发送键、键盘回车）都会经过它。
 *
 * workingDir 与菜单取数时同源（见 resolveWorkingDir）—— 否则项目级模板会「菜单里看得见、
 * 发送时认不出来」。只在文本真的以斜杠开头时才去问两个列表：绝大多数消息不付这次 IPC。
 * 读不到清单就原样发送：宁可不展开，也不能吞掉用户输入。
 */
async function expandSlashMessage(text: string, workingDir: string | undefined): Promise<string> {
  if (!text.startsWith("/")) return text;
  try {
    const [skills, templates] = await Promise.all([
      window.oint.skills.list(workingDir),
      window.oint.prompts.list(workingDir),
    ]);
    return expandSlashInput(text, buildSlashCommands(skills, templates));
  } catch {
    return text;
  }
}

/** 稳定的空数组常量：zustand v5 基于 useSyncExternalStore，
 *  选择器每次返回新引用会被判定为快照变化，从而触发无限重渲染（React #185）。 */
const EMPTY_MESSAGES: ChatMessage[] = [];

/** 渲染层运行时桥：把 chat-store 接入 assistant-ui 的 ExternalStoreRuntime */
export function OintRuntimeProvider({
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
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  /**
   * 当前会话的工作目录。只订阅 cwd 这一个值（不是整个 sessions 数组）：选择器返回字符串，
   * zustand 的 Object.is 比较才稳，切会话不会连带重渲染整棵 runtime 树。
   */
  const sessionCwd = useChatStore(
    (state) => state.sessions.find((session) => session.id === state.activeSessionId)?.cwd,
  );
  const defaultWorkingDir = useSettingsStore((state) => state.settings?.defaultWorkingDir);
  const workingDir = resolveWorkingDir(sessionCwd, defaultWorkingDir);

  // 主进程事件 → store reducer（卸载时取消订阅）
  useEffect(() => {
    const unsubscribe = startEventBridge((sessionId, event) => {
      useChatStore.getState().applyEvent(sessionId, event);
    });
    return unsubscribe;
  }, []);
  const onNew = useCallback(
    async (message: AppendMessage) => {
      const text = await expandSlashMessage(appendMessageToText(message), workingDir);
      const images = appendMessageToImages(message);
      await useChatStore.getState().send(text, images);
    },
    [workingDir],
  );

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
   * 侧栏的「置顶 / 项目 / 最近」分组不在这里切：分组要用到项目列表与会话的绑定目录，
   * 由 thread-list 部件直接读 chat-store 与 projects-store 计算（见 buildSidebarSections）——
   * 走商店的订阅比把数据塞进 custom 再读回来更直接，也保证置顶后立刻重新分组。
   *
   * 一处取舍：官方 thread list 只为「主线程」保留 runtime，非当前会话读不到运行状态，
   * 因此运行中指示只在当前会话上有效（原实现每个会话各自显示）。
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
    messages,
    isRunning,
    onNew,
    onCancel,
    onReload,
    convertMessage: toThreadMessage,
    adapters,
  });

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
