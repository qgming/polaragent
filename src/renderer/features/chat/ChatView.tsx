import type { SessionSearchHit } from "@/renderer/features/search";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ApprovalDecision } from "@/shared/contracts/approval";
import { Composer } from "./Composer";
import { ThreadView } from "./Thread";
import { ThreadToolbar } from "./ThreadToolbar";

interface ChatViewProps {
  /** 会话内搜索的当前命中；由 MainShell 的搜索条回传，透传给 Thread 做定位与高亮 */
  searchHit?: SessionSearchHit | null;
}

/**
 * 对话区入口：Thread + Composer 的组合。
 * 运行时由 App.tsx 的 PolarRuntimeProvider 提供（已接入），本组件只消费 runtime，
 * 不重复包 provider；若 App 未包，在调用方包一层即可。
 * 审批卡数据从 chat-store 读取，决策写回 store（resolveApproval）。
 */
export function ChatView({ searchHit = null }: ChatViewProps) {
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const resolveApproval = useChatStore((s) => s.resolveApproval);

  const handleResolve = (id: string, decision: ApprovalDecision, note?: string) => {
    // 与并行车道的真实签名一致：resolveApproval(id, decision, note?)
    void resolveApproval(id, decision, note);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadToolbar />
      <ThreadView approvals={pendingApprovals} onResolve={handleResolve} searchHit={searchHit} />
      <Composer />
    </div>
  );
}
