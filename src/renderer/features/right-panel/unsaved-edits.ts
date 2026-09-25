/**
 * 未保存的编辑：按绝对路径记着「这个文件的正文被改成过什么」。
 *
 * ## 为什么需要一个跨组件的表
 *
 * 编辑区在查看器里，而查看器会因为两件事被换掉：用户在文件面板里点了另一个文件
 * （或点「返回列表」），以及对话里点了另一张文件卡片（那会换掉查看器的目标）。
 * 这两件事都发生在查看器**之外**，组件拦不住 —— 拦不住的后果就是用户敲了一半的
 * 改动没了。所以正文不能只活在组件的 state 里：离开时把它留在这里，再打开同一个
 * 文件时接回来。
 *
 * 这条口径与编辑器一致（未保存的缓冲区不因为你看了别的文件就消失），也解释了为什么
 * 这里**不做确认对话框**：不丢东西就不需要问，问了反而把「看一眼别的文件」变成一次
 * 需要决策的打扰。
 *
 * ## 只记「有改动」的文件
 *
 * 值等于磁盘上的内容时不留条目（改回原样 = 没改过）。订阅者只关心**成员**（哪些文件
 * 有未保存的改动，文件列表据此打标记），所以成员没变时不通知，避免每敲一个字就重渲染
 * 一次列表。
 *
 * 进程内、内存里、不落盘：这是编辑草稿，不是用户数据（关掉应用就没了，与「未保存」的
 * 语义一致）。
 */

import { useSyncExternalStore } from "react";

const buffers = new Map<string, string>();
const listeners = new Set<() => void>();
/** 给 useSyncExternalStore 用的快照：只在成员变化时换一个新对象，没变时引用稳定 */
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  snapshot = new Set(buffers.keys());
  for (const listener of listeners) listener();
}

/** 这个文件有没有未保存的正文；没有时为 null */
export function unsavedOf(path: string): string | null {
  return buffers.get(path) ?? null;
}

/**
 * 记下 / 清掉一个文件的编辑草稿。
 *
 * `draft` 与磁盘上的 `diskText` 相同时按「没改动」处理 —— 用户把改坏的地方敲回去之后，
 * 文件列表上的「未保存」标记必须跟着消失。
 */
export function rememberUnsaved(path: string, draft: string, diskText: string): void {
  const wanted = draft !== diskText;
  const known = buffers.has(path);
  if (wanted === known) {
    // 成员没变：值要更新（下次接回来的是最新那一份），但不必通知订阅者
    if (wanted) buffers.set(path, draft);
    return;
  }
  if (wanted) buffers.set(path, draft);
  else buffers.delete(path);
  publish();
}

/** 保存成功 / 用户主动撤销之后调用 */
export function forgetUnsaved(path: string): void {
  if (!buffers.delete(path)) return;
  publish();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 有未保存改动的文件路径集合（文件列表据此打标记） */
export function useUnsavedPaths(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * 测试用：清空整张表。
 *
 * 它是**模块级**状态，不随组件卸载消失 —— 没有这个出口，一条用例留下的草稿会飘到
 * 下一条用例里（测试之间因此互相影响，而症状看起来像组件的问题）。
 */
export function resetUnsavedEdits(): void {
  if (buffers.size === 0) return;
  buffers.clear();
  publish();
}
