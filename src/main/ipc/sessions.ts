import { getChatRuntime } from "@/main/pisdk/runtime";
import { getSessionStore } from "@/main/pisdk/session-store";
import type { ModelRef } from "@/shared/contracts/common";
import { IPC } from "@/shared/contracts/ipc";
import {
  isHiddenSessionKind,
  type LoadSessionMessagesOptions,
  type SessionCreateOptions,
} from "@/shared/contracts/session";
import { handle } from "./handler";

/** 注册会话域通道；归档可见性由渲染层按设置过滤，主进程只挡掉从属会话 */
export function registerSessionsIpc(): void {
  const store = getSessionStore();

  // 子智能体这类从属会话不进左侧栏：过滤放在 IPC 层而不是 store ——
  // 内部调用方（子智能体运行时、搜索）还需要拿到完整列表来按 parentSessionId 关联
  handle(IPC.sessions.list, "读取会话列表", async () =>
    (await store.list()).filter((summary) => !isHiddenSessionKind(summary.kind)),
  );
  handle(IPC.sessions.create, "创建会话", (options?: SessionCreateOptions) =>
    store.create(options),
  );
  handle(IPC.sessions.rename, "重命名会话", (request: { id: string; title: string }) =>
    store.rename(request.id, request.title),
  );
  /**
   * 删除会话：**先关运行时再删库**。
   *
   * 顺序不能反：`store.remove` 会把 SQLite 文件删掉，而运行时还持有那个会话的
   * `AgentHarness` / `AgentLane` / `ExecutionEnv` 与一堆事件订阅 —— 先删文件的话，
   * 运行时就成了「指向已删除存储的活对象」，之后任何收尾（abort、close）都打在空处。
   * 早先这里没接 closeSession，于是每删一个会话就漏一整套运行时资源。
   */
  handle(IPC.sessions.delete, "删除会话", async (request: { id: string }) => {
    await getChatRuntime().closeSession(request.id);
    await store.remove(request.id);
  });
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
