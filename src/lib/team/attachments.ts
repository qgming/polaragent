import type { ChatAttachment } from "@/lib/chat";

export function serializeUserInputWithAttachments(
  userInput: string,
  attachments: ChatAttachment[] = [],
): string {
  const attachmentBlocks = attachments.map((attachment) => {
    const tag = attachment.kind === "image" ? "image" : "file";
    const label = attachment.kind === "image"
      ? "图片附件已随本消息以多模态内容发送。"
      : "文本附件已随首轮成员发言读取并发送。";
    return `<${tag} path="${attachment.path}" name="${attachment.name}">${label}</${tag}>`;
  });
  return attachmentBlocks.length > 0
    ? `${attachmentBlocks.join("\n\n")}\n\n${userInput}`
    : userInput;
}

export function textAttachmentPaths(attachments?: ChatAttachment[]): string[] {
  return (attachments ?? [])
    .filter((attachment) => attachment.kind === "text")
    .map((attachment) => attachment.path);
}
