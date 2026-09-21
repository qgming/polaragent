// 子智能体转录的取数规则（纯函数，可单测）。
//
// 从 SubagentPanel 抽出来是为了能测：本仓库的 vitest 里组件渲染设施有限
//（ui project 只收 *.test.tsx 且只加载 jsdom 垫片），而这段逻辑恰好是
// 一次真实缺陷的所在 —— 值得被钉住而不是留在组件里靠人看。

import type { ChatMessage } from "@/shared/contracts/session";

/**
 * 选一份用于显示的转录：**实时优先，落盘兜底**，并去掉开头的任务消息。
 *
 * ## 为什么要两个来源
 *
 * 子会话有两条数据通路，各有各的盲区：
 *
 * - **实时**（`chat-store.messagesBySession[childSessionId]`）：子会话的 `chat:event`
 *   与主会话走同一条通路（runtime 用子会话 id 发事件，`applyEvent` 不按会话过滤），
 *   所以这里有 token 级的实时消息。盲区是**冷启动 / 重启后内存里没有事件流**。
 * - **落盘**（`subagent-store.childMessages`）：一次 `sessions:load-messages` 读盘。
 *   盲区更多：只在被调用那一刻取一次，且内核按轮提交，所以最多是**轮次粒度**的快照。
 *
 * 于是「谁更长用谁」：实时那份在跑的时候一定不短于落盘那份（它含未落盘的尾部），
 * 而重启后实时为空、落盘才有历史。
 *
 * **不做逐条 merge**：两份来自同一个内核会话，实时那份只是「还没落盘的同一串消息」；
 * 逐条合并会在 id 与顺序上引入分歧，而收益只是省掉一次数组复制。
 *
 * ## 为什么要去掉开头那条
 *
 * 子会话的第一条消息**就是那次 Task 的任务文本**（runner 的 startChildRun 把它作为
 * prompt 发出去），而面板上方已经有一个「任务」区块在显示同一段文字。
 * 只去掉**开头**那一条 —— 后续的用户消息（插话）照常显示。
 */
export function pickTranscript(
  live: readonly ChatMessage[],
  persisted: readonly ChatMessage[],
): readonly ChatMessage[] {
  // 长度相同时也取实时：内容等价，但它的引用来自当前 store，更贴近「最新一份」的语义
  const raw = live.length >= persisted.length ? live : persisted;
  const first = raw[0];
  return first !== undefined && first.role === "user" ? raw.slice(1) : raw;
}
