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
import { JobToolUIs, SubagentToolUIs } from "@/renderer/features/chat/ToolParts";
import { resolveWorkingDir } from "@/renderer/features/chat/use-slash-commands";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import { SUBAGENT_TOOL_NAMES, useSubagentStore } from "@/renderer/stores/subagent-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts";
import { startEventBridge } from "./event-bridge";
import {
  appendMessageToImages,
  appendMessageToText,
  childSessionIdFromDetails,
  toThreadMessage,
} from "./message-converter";

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

  /**
   * 子转录修订号：已加载的子会话转录份数（只增不减，天然单调）。
   *
   * 为什么非得有这么个东西：assistant-ui 只在 convertMessage 的**函数引用**变化时才丢弃
   * 自己那份转换缓存（ExternalStoreThreadRuntimeCore 的 _converter），而 loadChild 只写
   * childMessages、**不动**父会话的 messages 数组 —— 只依赖 messages 的话，子转录到了
   * 也不会重算，嵌套消息永远不出现。把份数接进 convertMessage 的依赖，每多读到一份子转录
   * 就换一次引用，缓存随之失效并带着嵌套把整棵树重算一遍。
   * 取「份数」而不是 childMessages 对象本身：zustand v5 用 Object.is 比较快照，数字最稳，
   * 且这个数只增不减，正好当修订号（store 里已有的字段，不另造第二个真相来源）。
   */
  const childTranscriptRevision = useSubagentStore(
    (state) => Object.keys(state.childMessages).length,
  );

  /**
   * ChatMessage → assistant-ui 线程消息。
   *
   * 子会话转录在**转换发生的那一刻**用 getState() 取，而不是渲染时捕获快照 —— 解析函数
   * 因此永远读到最新一份；转换器自己仍是纯函数，只有这一层接触 store。
   * 依赖里的修订号不是转换的输入，只是让库丢掉缓存的失效信号（见上）。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 修订号是缓存失效信号，不是转换的输入
  const convertMessage = useCallback(
    (message: ChatMessage) =>
      toThreadMessage(message, (childSessionId) => {
        return useSubagentStore.getState().childMessages[childSessionId];
      }),
    [childTranscriptRevision],
  );

  /**
   * 主线程里的 Task 调用一出现就把子会话转录拉进来：嵌套消息要有内容可挂。
   *
   * 触发放在 provider 而不是 Task 卡片里：卡片只在当前视口挂载，而嵌套渲染取决于转换结果，
   * 用户不打开右侧面板、卡片没滚到可见处时这一步也得发生。store 动作只能在 effect 里调，
   * 不能在渲染期调；messages 变化就是唯一触发条件（Task 调用只会随消息到达），
   * loadChild 自身幂等，重复路过不会重复发 IPC。
   */
  useEffect(() => {
    const childSessionIds = new Set<string>();
    for (const message of messages) {
      for (const part of message.parts) {
        if (part.type !== "tool-call") continue;
        if (!SUBAGENT_TOOL_NAMES.includes(part.toolName)) continue;
        const childSessionId = childSessionIdFromDetails(part.details);
        if (childSessionId !== undefined) childSessionIds.add(childSessionId);
      }
    }
    for (const childSessionId of childSessionIds) {
      const store = useSubagentStore.getState();
      if (store.requestedChildren[childSessionId] === true) continue;
      void store.loadChild(childSessionId);
    }
  }, [messages]);

  // ChatMessage 是自定义类型，必须显式提供 convertMessage
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages,
    isRunning,
    onNew,
    onCancel,
    onReload,
    convertMessage,
    adapters,
  });

  /**
   * Task 系列注册成独立显示的工具 UI（见 ToolParts 的说明）。
   *
   * 挂在 provider 内部而不是 Thread 里：注册表是**运行时**的一部分，而 provider 就是
   * 创建那个运行时的地方；Thread 只是它的一个消费者，卸载换页时不该把注册一起带走。
   */
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <SubagentToolUIs />
      <JobToolUIs />
      {children}
    </AssistantRuntimeProvider>
  );
}
