import { useChatStore } from "@/renderer/stores/chat-store";
import type { ApprovalDecision } from "@/shared/contracts/approval";
import { EditMessageDialog } from "./EditMessageDialog";
import { ThreadView } from "./Thread";
import { ThreadToolbar } from "./ThreadToolbar";

/**
 * 对话区入口：ThreadToolbar + Thread 的组合。
 * 运行时由 App.tsx 的 OintRuntimeProvider 提供，本组件只消费 runtime，不重复包 provider。
 * Composer 由 Thread 的 ViewportFooter 渲染（与 assistant-ui 的 Thread 一致），这里不再单独挂。
 * 审批卡数据从 chat-store 读取，决定写回 store（resolveApproval）。
 */
export function ChatView() {
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const pendingApprovals = useChatStore((s) => s.pendingApprovals);
  const resolveApproval = useChatStore((s) => s.resolveApproval);

  /**
   * 只显示当前会话的审批卡：主进程里每个会话各有一条独立 lane，可以同时在跑 ——
   * 后台会话的审批不该弹在别的会话里（批准一次工具调用会作用到那条会话上）。
   * 后台会话挂着审批时，它自己的会话里会一直等着，侧栏那条会话同时在显示运行中。
   * 过滤放在渲染里而不是 selector 里：selector 每次返回新数组会被 zustand 判成快照变化。
   */
  const sessionApprovals = pendingApprovals.filter((item) => item.sessionId === activeSessionId);

  const handleResolve = (id: string, decision: ApprovalDecision, note?: string) => {
    void resolveApproval(id, decision, note);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ThreadToolbar />
      <ThreadView approvals={sessionApprovals} onResolve={handleResolve} />
      {/* 编辑模态挂在这里：它是对话区的功能，且不该跟着消息滚动 */}
      <EditMessageDialog />
    </div>
  );
}
