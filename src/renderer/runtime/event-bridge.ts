import type { ChatEventEnvelope } from "@/shared/contracts";

/**
 * 单事件分发：归属由主进程给出的信封决定（事件流里可能同时在跑多个会话），
 * 抽成纯函数便于单测，测试不依赖 window。
 */
export function dispatchEvent(
  onEvent: (sessionId: string, event: ChatEventEnvelope["event"]) => void,
  payload: ChatEventEnvelope,
): void {
  onEvent(payload.sessionId, payload.event);
}

/** 订阅主进程推送的聊天事件并把「会话 id + 事件」转发给 store；返回取消订阅函数 */
export function startEventBridge(
  onEvent: (sessionId: string, event: ChatEventEnvelope["event"]) => void,
): () => void {
  return window.oint.chat.onEvent((payload) => dispatchEvent(onEvent, payload));
}

/** 订阅窗口最大化状态变化；返回取消订阅函数 */
export function startWindowStateBridge(onChange: (maximized: boolean) => void): () => void {
  return window.oint.window.onMaximizedChange(onChange);
}
