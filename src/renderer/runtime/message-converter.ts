import type { AppendMessage, MessageStatus, ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, ChatPart } from "@/shared/contracts";

/** ThreadMessageLike 的 content 元素类型（从库类型推导，保证兼容） */
type ThreadPart =
  Exclude<ThreadMessageLike["content"], string> extends readonly (infer P)[] ? P : never;

/** 主进程消息 → assistant-ui 线程消息 */
export function toThreadMessage(message: ChatMessage): ThreadMessageLike {
  return {
    id: message.id,
    role: message.role,
    createdAt: new Date(message.createdAt),
    content: message.parts.map(toThreadPart),
    // assistant-ui 只允许 assistant 消息携带 status；用户消息带上会抛
    // "status is only supported for assistant messages" 并导致整树崩溃白屏
    ...(message.role === "assistant" ? { status: toMessageStatus(message) } : {}),
    // entryId 走 metadata.custom 通道透出：消息操作栏的「分支」需要它映射回 pi 条目
    ...(message.entryId === undefined
      ? {}
      : { metadata: { custom: { entryId: message.entryId } } }),
  };
}

/** ChatPart → 线程消息 part */
function toThreadPart(part: ChatPart): ThreadPart {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "reasoning":
      return { type: "reasoning", text: part.text };
    case "tool-call": {
      const partLike = {
        type: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        argsText: part.argsText,
        ...(part.args !== undefined ? { args: part.args } : {}),
        ...(part.result !== undefined ? { result: part.result } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
        // 工具的 details 走 assistant-ui 的 artifact 槽位（库声明的 UI 专用附属数据）。
        // 不能直接挂一个自造字段：那不是 ThreadMessageLike 的形状，会在归一化时被丢掉。
        ...(part.details !== undefined ? { artifact: part.details } : {}),
      };
      return partLike as ThreadPart;
    }
    case "image":
      return { type: "image", image: part.dataUrl };
  }
}

/** ChatMessage 状态 → MessageStatus（三态映射，编译期校验真实取值） */
function toMessageStatus(message: ChatMessage): MessageStatus {
  switch (message.status) {
    case "streaming":
      return { type: "running" };
    case "error":
      return {
        type: "incomplete",
        reason: "error",
        ...(message.error !== undefined ? { error: message.error } : {}),
      };
    case "complete":
      return { type: "complete", reason: "stop" };
  }
}

/** 提取用户发送的纯文本（拼接所有 text part，忽略其他类型） */
export function appendMessageToText(message: AppendMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

/** 从 image part 提取图片：dataUrl 拆出 mimeType 与 base64 数据，否则原样透传 */
export function appendMessageToImages(
  message: AppendMessage,
): { data: string; mimeType: string }[] {
  if (typeof message.content === "string") return [];
  const images: { data: string; mimeType: string }[] = [];
  for (const part of message.content) {
    if (part.type !== "image") continue;
    const { data, mimeType } = splitDataUrl(part.image);
    images.push({ data, mimeType });
  }
  return images;
}

/** 拆分 data URL：data:image/png;base64,xxxx → { mimeType: "image/png", data: "xxxx" } */
function splitDataUrl(image: string): { data: string; mimeType: string } {
  const match = /^data:([^;,]+)[^,]*,([\s\S]*)$/.exec(image);
  if (match) return { data: match[2] ?? "", mimeType: match[1] ?? "application/octet-stream" };
  // 非 dataUrl（裸 base64 / 引用）：无法得知类型，原样透传
  return { data: image, mimeType: "application/octet-stream" };
}
