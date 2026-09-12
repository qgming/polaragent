import { ipcMain } from "electron";
import { getInteractionService } from "@/main/pisdk/bootstrap";
import type { AskReply } from "@/shared/contracts/interaction";
import { IPC } from "@/shared/contracts/ipc";

/** 注册提问域通道；提问服务由 bootstrap 创建，此处只做转发与状态校验 */
export function registerInteractionsIpc(): void {
  ipcMain.handle(
    IPC.interaction.respond,
    async (_event, request: { id: string; reply: AskReply }) => {
      const interactions = getInteractionService();
      if (!interactions) throw new Error("提问服务尚未就绪，请稍后重试");
      try {
        interactions.respond(request.id, request.reply);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`提交回答失败：${String(error)}`);
        throw new Error(`提交回答失败：${detail}`);
      }
    },
  );
  ipcMain.handle(
    IPC.interaction.pending,
    async (_event, request: { sessionId?: string } | undefined) => {
      const interactions = getInteractionService();
      if (!interactions) throw new Error("提问服务尚未就绪，请稍后重试");
      return interactions.pending(request?.sessionId);
    },
  );
}
