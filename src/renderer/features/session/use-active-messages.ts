/**
 * 当前会话的消息列表（会话面板的唯一消息入口）。
 *
 * 直接读 store 的 `messagesBySession[activeSessionId]`：与 OintRuntimeProvider 喂给
 * aui runtime 的是同一份数组，区别只是不经 aui 的线程状态转发一步 ——
 * 会话面板挂在 TitleBar 上，读 store 就不依赖「面板渲染时 runtime 一定在树上」这件事。
 *
 * 选择器返回的是 store 里的数组本身（引用稳定），会话切换时引用变化 → 立刻重渲染，
 * 徽标因此跟着 activeSessionId 走，而不是等面板重新打开。
 */

import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessage } from "@/shared/contracts/session";

/** 稳定空引用：避免 zustand selector 每次返回新数组（会话没有消息 / 还没有会话时） */
const EMPTY_MESSAGES: readonly ChatMessage[] = [];

export function useActiveSessionMessages(): readonly ChatMessage[] {
  return useChatStore((state) =>
    state.activeSessionId === null
      ? EMPTY_MESSAGES
      : (state.messagesBySession[state.activeSessionId] ?? EMPTY_MESSAGES),
  );
}
