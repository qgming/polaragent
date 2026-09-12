import { getChatRuntime } from "@/main/pisdk/runtime";
import { getSessionStore } from "@/main/pisdk/session-store";
import type { ModelRef } from "@/shared/contracts/common";
import { IPC } from "@/shared/contracts/ipc";
import type { LoadSessionMessagesOptions } from "@/shared/contracts/session";
import { handle } from "./handler";

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
  handle(IPC.sessions.pin, "置顶会话", (request: { id: string; pinned: boolean }) =>
    store.setPinned(request.id, request.pinned),
  );
  handle(IPC.sessions.fork, "创建分支会话", (request: { id: string; entryId: string }) =>
    store.fork(request.id, request.entryId),
  );
  /**
   * 切换会话模型：走聊天运行时（要热改 lane 配置），不归会话存储管。
   * 运行时惰性获取 —— 注册早于 bootstrap 时不该在这里报未初始化。
   */
  handle(IPC.sessions.setModel, "切换会话模型", (request: { id: string; model: ModelRef | null }) =>
    getChatRuntime().setModel(request.id, request.model),
  );
  handle(
    IPC.sessions.loadMessages,
    "加载会话消息",
    (request: { id: string; options?: LoadSessionMessagesOptions }) =>
      store.loadMessages(request.id, request.options),
  );
}
