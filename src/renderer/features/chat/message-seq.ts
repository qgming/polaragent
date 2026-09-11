import type { ChatMessage } from "@/shared/contracts/session";

/**
 * 渲染侧那批消息是否就是 store 里当前会话的那批。
 *
 * 用途：`useExternalStoreRuntime` 在父级 effect 里才把新的消息数组推进运行时，
 * 因此组件读到的 `s.thread.messages` 总比 store 晚一帧 —— 切换会话那一帧里，
 * activeSessionId 已是新会话，messages 却还是旧会话的。任何「按消息 id 去 DOM 上定位」
 * 的逻辑都必须先确认这批 messages 真的属于当前会话，否则会在旧会话的 DOM 上误判。
 *
 * 判据取「逐条同 id + 长度相符」而不是「长度相同」或「只比首项」：
 * fork 出来的会话与源会话共用消息 id（见 src/main/pisdk/session-store.test.ts），
 * 长度与首项都可能恰好相同，只有逐条比对才分得开。
 *
 * `optimisticTail` 用来放行一种正常的「长度不等」：运行时在
 * `isRunning && 末条非 assistant` 时会自行追加一条乐观助手消息（随机 id，
 * 见 @assistant-ui/core 的 external-store-thread-runtime-core），
 * 此时渲染侧**必定**比 store 多一条。不放行的话，运行中点搜索结果就会推迟到
 * 助手条目落地才滚动 —— 而流式期间恰恰是最想跳的时候。
 * 它表达的是「预期恰好多一条」而不是「允许多一条」：仍要求前 N 条逐条同 id，
 * 且多出的条数必须正好是一，避免把「切换会话那一帧」也放进来。
 *
 * 入参只要 id，是因为两侧类型本就不同：store 里是 `ChatMessage`，
 * runtime 里是 assistant-ui 的 `MessageState`；这里不需要认识任何一个的具体形状。
 */
export function isMessageSequenceSynced(
  stored: readonly Pick<ChatMessage, "id">[],
  rendered: readonly { readonly id: string }[],
  /** 渲染侧此刻是否预期比 store 多一条尾部乐观助手消息 */
  optimisticTail = false,
): boolean {
  if (rendered.length !== stored.length + (optimisticTail ? 1 : 0)) return false;
  return stored.every((message, index) => message.id === rendered[index]?.id);
}
