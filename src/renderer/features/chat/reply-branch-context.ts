import { createContext } from "react";
import type { ReplyBranchInfo } from "./reply-variants";

/**
 * 回复分支的切换入口。
 *
 * 由 PolarRuntimeProvider 提供（它同时也是把可见消息喂给运行时的那一层），
 * 助手消息的底部操作栏消费：按自己的消息 id 查出所在分支与序号。
 * 单独一个模块是为了让 provider 与 Thread 都能引它，而不必互相依赖。
 */
export interface ReplyBranchValue {
  /** 可见消息 id → 它在自己分支里的位置；不在表里说明这条没有可切换的兄弟 */
  branchByMessageId: Record<string, ReplyBranchInfo>;
  onSelect: (parentId: string, index: number) => void;
}

export const ReplyBranchContext = createContext<ReplyBranchValue>({
  branchByMessageId: {},
  onSelect: () => undefined,
});
