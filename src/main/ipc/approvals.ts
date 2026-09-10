import { ipcMain } from "electron";
import { getApprovalService } from "@/main/pisdk/bootstrap";
import type { ApprovalDecision } from "@/shared/contracts/approval";
import { IPC } from "@/shared/contracts/ipc";

/** 注册审批域通道；审批服务由 bootstrap 创建，此处只做转发与状态校验 */
export function registerApprovalsIpc(): void {
  ipcMain.handle(
    IPC.approvals.respond,
    async (_event, request: { id: string; decision: ApprovalDecision; note?: string }) => {
      const approvals = getApprovalService();
      if (!approvals) throw new Error("审批服务尚未就绪，请稍后重试");
      try {
        await approvals.respond(request.id, request.decision, request.note);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`提交审批结果失败：${String(error)}`);
        throw new Error(`提交审批结果失败：${detail}`);
      }
    },
  );
}
