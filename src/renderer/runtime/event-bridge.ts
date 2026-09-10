import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatEvent } from "@/shared/contracts";

/**
 * 单事件分发：会话 id 通过 getSessionId 注入（事件本身不带会话 id），
 * 抽成纯函数便于单测，测试不依赖 window。
 */
export function dispatchEvent(
  getSessionId: () => string | null,
  onEvent: (sessionId: string, event: ChatEvent) => void,
  event: ChatEvent,
): void {
  const sessionId = getSessionId();
  if (!sessionId) return;
  onEvent(sessionId, event);
}

/** 订阅主进程聊天事件并转发给 store；返回取消订阅函数 */
export function startEventBridge(
  onEvent: (sessionId: string, event: ChatEvent) => void,
  getSessionId: () => string | null = () => useChatStore.getState().activeSessionId,
): () => void {
  return window.polaragent.chat.onEvent((event) => dispatchEvent(getSessionId, onEvent, event));
}

/** 订阅窗口最大化状态变化；返回取消订阅函数 */
export function startWindowStateBridge(onChange: (maximized: boolean) => void): () => void {
  return window.polaragent.window.onMaximizedChange(onChange);
}
