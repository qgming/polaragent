import { ipcMain } from "electron";
import { getSessionStore } from "@/main/pisdk/session-store";
import { IPC } from "@/shared/contracts/ipc";
import type { LoadSessionMessagesOptions } from "@/shared/contracts/session";

/** 把底层异常转成带中文描述的错误：Electron invoke 会把 message 原样传回渲染层 */
function fail(action: string, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`${action}失败：${detail}`);
}

/** 注册单个处理器并统一包裹异常与日志 */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  action: string,
  run: (...args: TArgs) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await run(...(args as TArgs));
    } catch (error) {
      console.warn(`${action}失败：${String(error)}`);
      throw fail(action, error);
    }
  });
}

/** 注册会话域通道；归档可见性由渲染层按设置过滤，主进程不做二次过滤 */
export function registerSessionsIpc(): void {
  const store = getSessionStore();

  handle(IPC.sessions.list, "读取会话列表", () => store.list());
  handle(IPC.sessions.create, "创建会话", (options?: { cwd?: string; title?: string }) =>
    store.create(options),
  );
  handle(IPC.sessions.rename, "重命名会话", (request: { id: string; title: string }) =>
    store.rename(request.id, request.title),
  );
  handle(IPC.sessions.delete, "删除会话", (request: { id: string }) => store.remove(request.id));
  handle(IPC.sessions.archive, "归档会话", (request: { id: string; archived: boolean }) =>
    store.setArchived(request.id, request.archived),
  );
  handle(IPC.sessions.fork, "创建分支会话", (request: { id: string; entryId: string }) =>
    store.fork(request.id, request.entryId),
  );
  handle(
    IPC.sessions.loadMessages,
    "加载会话消息",
    (request: { id: string; options?: LoadSessionMessagesOptions }) =>
      store.loadMessages(request.id, request.options),
  );
}
