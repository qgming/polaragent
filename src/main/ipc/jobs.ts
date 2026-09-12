import { ipcMain } from "electron";
import { getChatRuntime } from "@/main/pisdk/runtime";
import { IPC } from "@/shared/contracts/ipc";

/**
 * 注册后台作业域通道。
 *
 * 运行时经 getChatRuntime() 惰性获取（与 chat.ts 同源，不自建单例）：作业表就在运行时内部，
 * 换一份实例就会让渲染层看到的作业与模型工具操作的对不上。作业变动本身走 job-changed /
 * job-removed 事件推送，这两个通道只负责「首次列表面板」与「用户点停止」。
 */
export function registerJobsIpc(): void {
  ipcMain.handle(IPC.jobs.list, async (_event, request: { sessionId: string }) => {
    try {
      return getChatRuntime().listJobs(request.sessionId);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`读取后台作业失败：${String(error)}`);
      throw new Error(`读取后台作业失败：${detail}`);
    }
  });
  ipcMain.handle(IPC.jobs.kill, async (_event, request: { sessionId: string; id: string }) => {
    try {
      return await getChatRuntime().killJob(request.sessionId, request.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`停止后台作业失败：${String(error)}`);
      throw new Error(`停止后台作业失败：${detail}`);
    }
  });
}
