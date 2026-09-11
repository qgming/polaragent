import { useChatStore } from "@/renderer/stores/chat-store";
import type { ApprovalDecision } from "@/shared/contracts/approval";
import { EditMessageDialog } from "./EditMessageDialog";
import { ThreadView } from "./Thread";
import { ThreadToolbar } from "./ThreadToolbar";

/**
 * 对话区入口：ThreadToolbar + Thread 的组合。
 * 运行时由 App.tsx 的 PolarRuntimeProvider 提供，本组件只消费 runtime，不重复包 provider。
 * Composer 由 Thread 的 ViewportFooter 渲染（与 assistant-ui 的 Thread 一致），这里不再单独挂。
 * 审批卡数据从 chat-store 读取，决定写回 store（resolveApproval）。
 */
export function ChatView() {
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const resolveApproval = useChatStore((s) => s.resolveApproval);

  const handleResolve = (id: string, decision: ApprovalDecision, note?: string) => {
    void resolveApproval(id, decision, note);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadToolbar />
      <ThreadView approvals={pendingApprovals} onResolve={handleResolve} />
      {/* 编辑模态挂在这里：它是对话区的功能，且不该跟着消息滚动 */}
      <EditMessageDialog />
    </div>
  );
}
