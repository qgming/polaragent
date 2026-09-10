// PolarAgent × assistant-ui Runtime 桥接
// src/runtime/PolarAgentRuntimeProvider.tsx
//
// ExternalStoreRuntime：UI 只依赖 assistant-ui context；
// 消息状态仍在 zustand chat-store；发送/取消/重生成桥接到 pi-sdk AgentHarness。

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { useCallback, useMemo, type ReactNode } from "react";

import { abortAgentThread, promptAgent } from "@/ai/agent";
import type {
  ChatAttachment,
  ChatMessage,
  ChatMessagePart,
} from "@/lib/chat";
import { partsToPlainText } from "@/lib/chat";
import { useChatStore } from "@/stores/chat-store";
import { useComposerExtrasStore } from "@/runtime/composer-extras-store";
import { navNewThread, navSelectThread } from "@/runtime/nav-bridge";

/** ChatMessage → assistant-ui ThreadMessageLike（近恒等，避免每帧重映射） */
function convertMessage(message: ChatMessage): ThreadMessageLike {
  const status: ThreadMessageLike["status"] =
    message.status === "running" ?
      { type: "running" }
    : message.status === "error" ?
      {
        type: "incomplete",
        reason: "error",
        error: message.metadata?.error ?? "error",
      }
    : { type: "complete", reason: "stop" };

  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: message.content as ThreadMessageLike["content"],
    status: message.role === "assistant" ? status : undefined,
    attachments: message.attachments?.map((a) => ({
      type: a.kind === "image" ? ("image" as const) : ("file" as const),
      name: a.name,
      url: a.path,
    })) as ThreadMessageLike["attachments"],
  };
}

function extractUserContext(message: AppendMessage): {
  text: string;
  attachments: ChatAttachment[];
} {
  const text = partsToPlainText(message.content as ChatMessagePart[]);
  const attachments: ChatAttachment[] = [];
  for (const part of message.content) {
    if (part.type === "file" || part.type === "image") {
      const anyPart = part as { name?: string; url?: string };
      if (anyPart.url) {
        attachments.push({
          path: anyPart.url,
          name: anyPart.name ?? "file",
          kind: part.type === "image" ? "image" : "document",
        });
      }
    }
  }
  return { text, attachments };
}

function buildPromptOptions(
  threadId: string,
  userMessage?: ChatMessage,
  extras?: { filePaths?: string[] },
) {
  const store = useChatStore.getState();
  const thread = store.threads.find((t) => t.id === threadId);
  const workingDir = thread?.workingDir || store.workingDir || undefined;
  return {
    threadId,
    workingDir,
    attachments: userMessage?.attachments,
    filePaths: extras?.filePaths,
    permissionMode: thread?.permissionMode,
  };
}

function runAgentForAssistant(
  threadId: string,
  assistantId: string,
  text: string,
  options: ReturnType<typeof buildPromptOptions>,
) {
  return promptAgent(
    text,
    {
      onStreamUpdate: (update) => {
        if (update.parts) {
          useChatStore
            .getState()
            .applyStreamingParts(threadId, assistantId, update.parts);
        }
      },
      onDone: (result) => {
        useChatStore.getState().finishAssistant(threadId, assistantId, "", {
          model: result.model,
          tokenCount: result.usage.totalTokens,
          inputTokens: result.usage.input,
          outputTokens: result.usage.output,
          cacheReadTokens: result.usage.cacheRead,
          cacheWriteTokens: result.usage.cacheWrite,
          contextTokens: result.contextTokens,
          content: result.content,
        });
      },
      onError: (errorMessage) => {
        console.error("[Runtime] agent error", threadId, errorMessage);
        useChatStore
          .getState()
          .failAssistant(threadId, assistantId, errorMessage);
      },
    },
    { ...options, messageId: assistantId },
  ).catch((error: unknown) => {
    // promptAgent 内部多数错误会走 onError；此处兜底未捕获异常，
    // 避免 onNew reject 后 assistant-ui 只显示笼统 Connection error。
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Runtime] promptAgent threw", threadId, error);
    useChatStore.getState().failAssistant(threadId, assistantId, message);
  });
}

export function PolarAgentRuntimeProvider({ children }: { children: ReactNode }) {
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const runningThreadIds = useChatStore((s) => s.runningThreadIds);
  const hydrated = useChatStore((s) => s.hydrated);

  const isRunning = activeThreadId
    ? runningThreadIds.includes(activeThreadId)
    : false;

  const activeMessages = useMemo(() => {
    const thread = threads.find((t) => t.id === activeThreadId);
    return thread?.loaded ? thread.messages : [];
  }, [threads, activeThreadId]);

  const onNew = useCallback(async (message: AppendMessage) => {
    try {
      const store = useChatStore.getState();
      let threadId = store.activeThreadId;
      if (!threadId) {
        threadId = store.createThread();
      }

      const { text, attachments } = extractUserContext(message);
      if (!text.trim() && attachments.length === 0) {
        return;
      }
      const extras = useComposerExtrasStore.getState();
      const filePaths = [...extras.filePaths];
      extras.clear();

      const start = store.startExchange(text, attachments);
      const options = buildPromptOptions(threadId, undefined, {
        filePaths: filePaths.length > 0 ? filePaths : undefined,
      });
      await runAgentForAssistant(threadId, start.assistantId, text, {
        ...options,
        attachments,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[Runtime] onNew failed", error);
      const threadId = useChatStore.getState().activeThreadId;
      const thread = useChatStore.getState().threads.find((t) => t.id === threadId);
      const lastAssistant = [...(thread?.messages ?? [])]
        .reverse()
        .find((m) => m.role === "assistant" && m.status === "running");
      if (threadId && lastAssistant) {
        useChatStore.getState().failAssistant(threadId, lastAssistant.id, message);
      }
    }
  }, []);

  const onCancel = useCallback(async () => {
    const threadId = useChatStore.getState().activeThreadId;
    if (threadId) abortAgentThread(threadId);
  }, []);

  /** 从指定用户消息截断其后内容，并生成新的助手回复 */
  const regenerateAfterUser = useCallback(
    async (threadId: string, userMessageId: string) => {
      const store = useChatStore.getState();
      const thread = store.threads.find((t) => t.id === threadId);
      if (!thread) return;
      const userMsg = thread.messages.find((m) => m.id === userMessageId);
      if (!userMsg || userMsg.role !== "user") return;

      store.truncateFrom(threadId, userMessageId);
      const text = partsToPlainText(userMsg.content);
      const assistantId = store.appendAssistantPlaceholder(threadId);
      const options = buildPromptOptions(threadId, userMsg);
      await runAgentForAssistant(threadId, assistantId, text, options);
    },
    [],
  );

  const onReload = useCallback(
    async (parentId: string | null) => {
      const store = useChatStore.getState();
      const threadId = store.activeThreadId;
      if (!threadId) return;
      let userMessageId = parentId;
      if (!userMessageId) {
        const thread = store.threads.find((t) => t.id === threadId);
        for (let i = (thread?.messages.length ?? 0) - 1; i >= 0; i--) {
          const msg = thread!.messages[i];
          if (msg.role === "user") {
            userMessageId = msg.id;
            break;
          }
        }
      }
      if (!userMessageId) return;
      await regenerateAfterUser(threadId, userMessageId);
    },
    [regenerateAfterUser],
  );

  const onEdit = useCallback(
    async (message: AppendMessage) => {
      const store = useChatStore.getState();
      const threadId = store.activeThreadId;
      if (!threadId) return;
      const parentId = message.parentId;
      if (!parentId) return;

      const thread = store.threads.find((t) => t.id === threadId);
      if (!thread) return;
      const userMsg = thread.messages.find((m) => m.id === parentId);
      if (!userMsg) return;

      const { text } = extractUserContext(message);
      // 保留该用户消息之前的内容，替换其文本，截断其后，再重新生成
      store.truncateFrom(threadId, parentId);
      // truncateFrom 保留到 parentId（含），接下来用替换后的内容重建
      // 这里通过 set 直接改最后一条用户消息文本
      useChatStore.setState((s) => ({
        threads: s.threads.map((t) => {
          if (t.id !== threadId) return t;
          return {
            ...t,
            messages: t.messages.map((m) =>
              m.id === parentId
                ? {
                    ...m,
                    content: [{ type: "text" as const, text }],
                    attachments: userMsg.attachments,
                  }
                : m,
            ),
          };
        }),
      }));

      const assistantId = store.appendAssistantPlaceholder(threadId);
      const options = buildPromptOptions(threadId, userMsg);
      await runAgentForAssistant(threadId, assistantId, text, options);
    },
    [],
  );

  const threadListAdapter: ExternalStoreThreadListAdapter = useMemo(
    () => ({
      threadId: activeThreadId || undefined,
      isLoading: !hydrated,
      threads: threads.map((t) => ({
        status: "regular" as const,
        id: t.id,
        title: t.title,
      })),
      onSwitchToNewThread: () => {
        useChatStore.getState().showHome();
        navNewThread();
      },
      onSwitchToThread: (threadId: string) => {
        useChatStore.getState().selectThread(threadId);
        navSelectThread(threadId);
      },
      onRename: (threadId: string, newTitle: string) => {
        useChatStore.getState().renameThread(threadId, newTitle);
      },
      onDelete: (threadId: string) => {
        abortAgentThread(threadId);
        useChatStore.getState().deleteThread(threadId);
      },
    }),
    [threads, activeThreadId, hydrated],
  );

  const runtime = useExternalStoreRuntime({
    isRunning,
    isDisabled: !hydrated,
    messages: activeMessages,
    convertMessage,
    onNew,
    onCancel,
    onReload,
    onEdit,
    adapters: {
      threadList: threadListAdapter,
    },
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
