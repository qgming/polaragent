/**
 * 重新生成后的回复分支：同一父消息下的多条助手回复互为分支。
 *
 * pi 的条目树里，重新生成产生的新回复与旧回复共享同一个 parentId（见 runtime 的回退实现），
 * 这个模块把扁平的会话消息列表按 parentId 收敛成「一次只展示一条」的视图，
 * 同时给出每条可见消息在自己分支里的序号与总数，供底部操作栏的切换按钮使用。
 *
 * 纯逻辑、不依赖 React：切换规则（默认选最新、越界钳制）需要能单独测。
 */

import type { ChatMessage } from "@/shared/contracts/session";

/** 一条可见回复在它所属分支里的位置 */
export interface ReplyBranchInfo {
  /** 该分支下所有变体共有的父消息 id */
  parentId: string;
  /** 从 0 起的序号 */
  index: number;
  /** 变体总数（≥ 2 才会显示切换按钮） */
  count: number;
}

export interface ReplyResolution {
  /** 要交给运行时展示的消息：每条分支只留选中的那一条 */
  visible: ChatMessage[];
  /** 可见消息 id → 它所属分支的位置信息 */
  branchByMessageId: Record<string, ReplyBranchInfo>;
}

/** 分组键：助手消息的 parentId。没有 parentId 的（流式中尚未落盘）不参与分组 */
function groupKey(message: ChatMessage): string | null {
  if (message.role !== "assistant") return null;
  const parentId = message.parentId;
  return typeof parentId === "string" && parentId !== "" ? parentId : null;
}

/**
 * 把消息列表按回复分支收敛。
 *
 * @param selection 分支选择：parentId → 变体下标。缺省取最后一条 ——
 *   重新生成是在末尾追加，最新一条即用户刚看到的那条，与「重试」的直觉一致。
 */
export function resolveReplies(
  messages: readonly ChatMessage[],
  selection: Readonly<Record<string, number>> = {},
): ReplyResolution {
  const groups = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const key = groupKey(message);
    if (key === null) continue;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [message]);
    else list.push(message);
  }

  const visible: ChatMessage[] = [];
  const branchByMessageId: Record<string, ReplyBranchInfo> = {};

  for (const message of messages) {
    const key = groupKey(message);
    const group = key === null ? undefined : groups.get(key);
    // 没有分组、或这一组只有一条：原样展示，不给切换入口
    if (key === null || group === undefined || group.length < 2) {
      visible.push(message);
      continue;
    }

    const picked = clampIndex(selection[key], group.length);
    const chosen = group[picked];
    if (chosen === undefined) continue;
    // 只有选中的那条进入可见列表；其余变体留在 store 里，靠切换再拿出来
    if (chosen.id !== message.id) continue;

    visible.push(chosen);
    branchByMessageId[chosen.id] = { parentId: key, index: picked, count: group.length };
  }

  return { visible, branchByMessageId };
}

/** 选择下标钳制到合法范围；缺省或非法值取最后一条（最新回复） */
function clampIndex(value: number | undefined, count: number): number {
  if (value === undefined || !Number.isInteger(value)) return count - 1;
  if (value < 0) return 0;
  return value > count - 1 ? count - 1 : value;
}

