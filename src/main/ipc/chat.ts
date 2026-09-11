import type { ImageContent } from "@earendil-works/pi-ai";
import { ipcMain } from "electron";
import { getChatRuntime } from "@/main/pisdk/runtime";
import type { ChatSendOptions } from "@/shared/contracts/chat";
import { IPC } from "@/shared/contracts/ipc";

/** 渲染层传入的图片附件：data 为 base64 或 dataUrl；这里补齐 pi 所需的 type 判别字段 */
type ChatImage = { data: string; mimeType: string };

function toImageContents(images: ChatImage[] | undefined): ImageContent[] | undefined {
  return images?.map((image) => ({ type: "image" as const, ...image }));
}

/** 注册单个处理器并统一包裹异常：Electron invoke 会把 message 原样传回渲染层 */
function handle<TArgs extends unknown[], TResult>(
  channel: string,
  action: string,
  run: (...args: TArgs) => Promise<TResult> | TResult,
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await run(...(args as TArgs));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`${action}失败：${String(error)}`);
      throw new Error(`${action}失败：${detail}`);
    }
  });
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
}
