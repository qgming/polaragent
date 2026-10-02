import { getChatRuntime } from "@/main/pisdk/runtime";
import type { ChatAttachment } from "@/shared/contracts/attachment";
import type { ChatSendOptions } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";
import { handle } from "./handler";

/**
 * 注册聊天域通道；运行时惰性获取，避免注册早于 bootstrap 时误报未初始化。
 *
 * 附件（图片 / 视频 / 文本 / 其他文件）在这里**原样透传**给运行时：落盘、抽帧后的
 * 内容块组装、以及「读不出来就判整次发送失败」都在 runtime 的 send 里，
 * 因为那是唯一同时知道会话 id 与运行状态的地方。IPC 层不再做一层形状转换 ——
 * 早先那层 `toImageContents` 只是把 `{data,mimeType}` 套上 `type:"image"`，
 * 除了多一个可能与契约漂移的地方之外没有别的作用。
 */
export function registerChatIpc(): void {
  handle(
    IPC.chat.send,
    "发送消息",
    async (request: {
      sessionId: string;
      text: string;
      attachments?: ChatAttachment[];
      messageId?: string;
      /** 重新生成 / 编辑：先把 lane 回退到指定条目再运行 */
      options?: ChatSendOptions;
    }) => {
      await getChatRuntime().send(
        request.sessionId,
        request.text,
        request.attachments,
        request.messageId,
        request.options,
      );
    },
  );
  handle(IPC.chat.stop, "停止运行", async (request: { sessionId: string }) => {
    await getChatRuntime().stop(request.sessionId);
  });
  handle(
    IPC.chat.queue,
    "排队消息",
    async (request: { sessionId: string; text: string; mode: "steer" | "followUp" }) => {
      await getChatRuntime().queue(request.sessionId, request.text, request.mode);
    },
  );
  handle(
    IPC.chat.cancelQueued,
    "撤销排队消息",
    async (request: { sessionId: string; entryId: string }) => {
      await getChatRuntime().cancelQueued(request.sessionId, request.entryId);
    },
  );
  handle(
    IPC.chat.compact,
    "压缩上下文",
    async (request: { sessionId: string; instructions?: string }) => {
      // 结果对象原样回传：busy / nothing 是正常结局，不是需要包装成异常的失败
      return getChatRuntime().compact(request.sessionId, request.instructions);
    },
  );
  handle(IPC.chat.snapshot, "读取流式快照", async (request: { sessionId: string }) => {
    return getChatRuntime().streamSnapshot(request.sessionId);
  });
}
