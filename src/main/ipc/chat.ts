import type { ImageContent } from "@earendil-works/pi-ai";
import { getChatRuntime } from "@/main/pisdk/runtime";
import type { ChatSendOptions } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";
import { handle } from "./handler";

/** 渲染层传入的图片附件：data 为 base64 或 dataUrl；这里补齐 pi 所需的 type 判别字段 */
type ChatImage = { data: string; mimeType: string };

function toImageContents(images: ChatImage[] | undefined): ImageContent[] | undefined {
  return images?.map((image) => ({ type: "image" as const, ...image }));
}

/** 注册聊天域通道；运行时惰性获取，避免注册早于 bootstrap 时误报未初始化 */
export function registerChatIpc(): void {
  handle(
    IPC.chat.send,
    "发送消息",
    async (request: {
      sessionId: string;
      text: string;
      images?: ChatImage[];
      messageId?: string;
      /** 重新生成 / 编辑：先把 lane 回退到指定条目再运行 */
      options?: ChatSendOptions;
    }) => {
      await getChatRuntime().send(
        request.sessionId,
        request.text,
        toImageContents(request.images),
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
    IPC.chat.compact,
    "压缩上下文",
    async (request: { sessionId: string; instructions?: string }) => {
      await getChatRuntime().compact(request.sessionId, request.instructions);
    },
  );
  handle(IPC.chat.snapshot, "读取流式快照", async (request: { sessionId: string }) => {
    return getChatRuntime().streamSnapshot(request.sessionId);
  });
}
