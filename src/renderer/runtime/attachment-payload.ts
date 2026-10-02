// assistant-ui 的附件 → 我们的附件契约。
//
// ## 为什么这个文件是这次修复的核心
//
// assistant-ui 的 `AppendMessage` 把附件放在**与 `content` 并列的独立字段** `attachments`
// 里，`content` 只有文本：
//
//   content:     [{ type: "text", text: "看这张图" }]
//   attachments: [{ type: "image", name: "shot.png", status: {type:"complete"},
//                   content: [{ type: "image", image: "data:image/png;base64,…" }] }]
//
// 早先的代码只扫 `message.content`，于是**图片从来没有离开过渲染进程** ——
// 界面上不显示（乐观消息里没有 image part），模型也收不到（images 恒为 undefined）。
// 这个文件是那个字段的唯一读取口，测试直接钉在它上面。
//
// ## 两级形状
//
// 适配器在 `send()` 之前把 File 探成 `ChatAttachment`（抽帧、降采样、读文本都在那时做完），
// 结果放进附件的 `content` 里作为一个 `data` part。这里再把它取出来 —— 走库的官方槽位
// （`ThreadUserMessagePart` 的 `data` 变体）而不是往对象上挂自造字段：自造字段会在
// 库内部的对象拷贝里丢掉，而丢掉的表现恰好又是「附件静默消失」。

import type { AppendMessage, Attachment } from "@assistant-ui/react";
import {
  classifyFile,
  encodeImageForModel,
  extractVideoFrames,
  fileToBase64,
  readTextPrefix,
} from "@/renderer/lib/attachment-file";
import {
  type AttachmentPart,
  type ChatAttachment,
  type ChatAttachmentKind,
  MAX_ATTACHMENT_BYTES,
} from "@/shared/contracts/attachment";
import type { ChatPart } from "@/shared/contracts/session";

/** 附件负载在 `data` part 上的名字（`components.data.by_name` 按它派发） */
export const ATTACHMENT_DATA_PART = "oint.attachment";

/** 扩展名 → MIME 的兜底表：浏览器给空 type 时（拖拽的 .log/.env、无扩展名文件）用 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  md: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  xml: "application/xml",
  yaml: "application/x-yaml",
  yml: "application/x-yaml",
  zip: "application/zip",
};

/** 按扩展名猜 MIME；猜不出就 octet-stream（主进程会按内容再嗅探） */
export function guessMimeType(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0) return "application/octet-stream";
  return MIME_BY_EXTENSION[name.slice(at + 1).toLowerCase()] ?? "application/octet-stream";
}

/** 这个 File 在磁盘上的真实路径；拿不到（剪贴板 / Blob）返回空串 */
function pathForFile(file: File): string {
  try {
    return window.oint.files.pathForFile(file);
  } catch {
    return "";
  }
}

/**
 * 有路径就不带字节，没有路径才把字节 base64 过来。
 *
 * 这是这次改动里最实在的一处：一个 200 MB 的视频，走路径是主进程直接读盘；
 * 走 base64 是渲染层先读一遍、编码成字符串、IPC 结构化克隆再拷一份 —— 三份内存。
 *
 * 没有路径**又**超过上限时直接拒绝：那种情况下把整个文件读进渲染进程只会把它拖垮，
 * 而拒绝会作为附件的错误态显示在卡片上（见 attachment-adapter 的 add），
 * 用户看得见「为什么不行」，而不是界面卡死。
 */
async function bytesOnlyWithoutPath(
  path: string,
  file: File,
): Promise<Pick<ChatAttachment, "data"> | Record<string, never>> {
  if (path !== "") return {};
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `附件「${file.name}」有 ${file.size} 字节，超过 ${MAX_ATTACHMENT_BYTES} 字节的上限，` +
        "且拿不到它的磁盘路径，无法发送",
    );
  }
  return { data: await fileToBase64(file) };
}

/**
 * 把一个 File 探成给主进程的附件描述。
 *
 * **这是重活**（视频抽帧要几秒），所以它在适配器的 `add()` 里做，而不是 `send()`：
 * `send()` 一被调用，库就立刻清空输入框与附件列表，用户在那几秒里看不到任何东西；
 * 放在 `add()` 里则附件缩略图先出现、带一个处理中的态，处理完再变成就绪。
 *
 * 每一步失败都降级：图解码不了 → 当普通文件（只给路径）；视频抽不了帧 → 只给路径；
 * 文本读不出来 → 当二进制。**绝不因为探不动就丢掉用户的东西**。
 */
export async function probeAttachment(file: File): Promise<ChatAttachment> {
  const name = file.name === "" ? "attachment" : file.name;
  const mimeType = file.type === "" ? guessMimeType(name) : file.type;
  const kind = classifyFile(name, mimeType);
  const path = pathForFile(file);
  const base = {
    name,
    mimeType,
    size: file.size,
    ...(path === "" ? {} : { path }),
  };

  if (kind === "image") {
    const encoded = await encodeImageForModel(file);
    if (encoded !== null) {
      return {
        ...base,
        kind: "image",
        images: [{ mimeType: encoded.mimeType, data: encoded.data }],
        width: encoded.width,
        height: encoded.height,
        ...(encoded.reencoded ? { downscaled: true } : {}),
        ...(await bytesOnlyWithoutPath(path, file)),
      };
    }
    // 解不出来（损坏的图 / 不支持的编码）：退回按文件给路径，至少模型还能用工具试
    return { ...base, kind: "file", ...(await bytesOnlyWithoutPath(path, file)) };
  }

  if (kind === "video") {
    const sampled = await extractVideoFrames(file);
    return {
      ...base,
      kind: "video",
      ...(sampled === null
        ? {}
        : {
            images: sampled.frames,
            frameTimes: sampled.frameTimes,
            durationSeconds: sampled.durationSeconds,
            width: sampled.width,
            height: sampled.height,
          }),
      ...(await bytesOnlyWithoutPath(path, file)),
    };
  }

  if (kind === "text") {
    let text = "";
    let truncated = false;
    try {
      const read = await readTextPrefix(file);
      text = read.text;
      truncated = read.truncated;
    } catch {
      // 读不出来（编码奇怪 / 权限）：当二进制处理，路径照样给
      return { ...base, kind: "file", ...(await bytesOnlyWithoutPath(path, file)) };
    }
    if (text.trim() === "" && !truncated) {
      return { ...base, kind: "file", ...(await bytesOnlyWithoutPath(path, file)) };
    }
    return {
      ...base,
      kind: "text",
      text,
      ...(truncated ? { textTruncated: true } : {}),
      ...(await bytesOnlyWithoutPath(path, file)),
    };
  }

  return { ...base, kind: "file", ...(await bytesOnlyWithoutPath(path, file)) };
}

/** 形状校验：负载来自库的 `data` 槽位，是 unknown，这里只认自己写进去的那一种 */
function isChatAttachment(value: unknown): value is ChatAttachment {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChatAttachment>;
  const kinds: ChatAttachmentKind[] = ["image", "video", "text", "file"];
  return (
    typeof candidate.name === "string" &&
    typeof candidate.mimeType === "string" &&
    typeof candidate.size === "number" &&
    candidate.kind !== undefined &&
    kinds.includes(candidate.kind)
  );
}

/** 旧形状兜底：附件把图片直接放在 `content` 里的 image part（适配器换实现时的保险） */
function imageFromLegacyContent(content: readonly { type: string }[]): ChatAttachment | null {
  for (const part of content) {
    if (part.type !== "image") continue;
    const image = (part as { image?: unknown }).image;
    if (typeof image !== "string") continue;
    const match = /^data:([^;,]+)[^,]*,([\s\S]*)$/.exec(image);
    return {
      kind: "image",
      name: "image",
      mimeType: match?.[1] ?? "image/png",
      size: 0,
      images: [{ mimeType: match?.[1] ?? "image/png", data: match?.[2] ?? image }],
    };
  }
  return null;
}

/**
 * 从**一个**附件里取出它的负载（探测结果）。
 *
 * 适配器的 `send()` 用它判断「探测是不是已经做完了」：拿得到就说明 add() 已经
 * yield 过带 `content` 的那一版，拿不到就意味着用户抢在探测完成之前按了发送。
 */
export function payloadFromAttachment(attachment: Attachment): ChatAttachment | undefined {
  for (const part of attachment.content ?? []) {
    if (part.type !== "data" || part.name !== ATTACHMENT_DATA_PART) continue;
    if (isChatAttachment(part.data)) return part.data;
  }
  return undefined;
}

/**
 * 从 `AppendMessage` 里取出全部附件。
 *
 * 读的是 `message.attachments` —— **不是** `message.content`（见文件头）。
 * 库把附件放在那里，任何只扫 content 的写法都会静默丢掉全部附件。
 */
export function appendMessageToAttachments(message: AppendMessage): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  for (const attachment of message.attachments ?? []) {
    const content = attachment.status.type === "complete" ? attachment.content : [];
    const payload = payloadFromAttachment(attachment);
    if (payload !== undefined) {
      attachments.push(payload);
      continue;
    }
    const legacy = imageFromLegacyContent(content);
    if (legacy !== null) attachments.push(legacy);
  }
  return attachments;
}

/**
 * 附件 → 乐观消息里的 part（发送瞬间就画出来，不等主进程回显）。
 *
 * `path` 在乐观期可能为空（主进程还没落盘），帧直接用探测时留下的那些 ——
 * 所以用户点发送之后立刻能看到自己贴的图，而不是等一轮 IPC 往返。
 */
export function attachmentsToParts(attachments: readonly ChatAttachment[]): AttachmentPart[] {
  return attachments.map((attachment, index) => {
    const frames = (attachment.images ?? []).map((image) => ({
      mimeType: image.mimeType,
      dataUrl: toDataUrl(image),
    }));
    return {
      type: "attachment",
      index: index + 1,
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      ...(attachment.path === undefined ? {} : { path: attachment.path }),
      ...(frames.length === 0 ? {} : { frames }),
      ...(attachment.durationSeconds === undefined
        ? {}
        : { durationSeconds: attachment.durationSeconds }),
      ...(attachment.width === undefined ? {} : { width: attachment.width }),
      ...(attachment.height === undefined ? {} : { height: attachment.height }),
      ...(attachment.kind === "video" ? { frameCount: frames.length } : {}),
      ...(attachment.textTruncated === true ? { textTruncated: true } : {}),
      ...(attachment.downscaled === true ? { downscaled: true } : {}),
    };
  });
}

/** data URL → 裸 base64；不是 data URL 时原样返回 */
export function base64FromDataUrl(value: string): string {
  const comma = value.indexOf(",");
  return comma === -1 ? value : value.slice(comma + 1);
}

/**
 * 消息 part → 附件（重新生成 / 编辑重发用）。
 *
 * 只带得走 part 里有的东西：`path`（主进程按它读回原文件）与 `frames`（视频帧主进程
 * 抽不出来，只能从这里带回去）。文本正文也一样 —— 主进程缺 `text` 时会自己按路径读。
 *
 * `index` 在这里重排：重发时附件集合可能变（编辑只改文本、或将来支持删掉某条），
 * 沿用旧下标会让信封里的 `index` 与实际顺序对不上。
 */
export function attachmentsFromParts(parts: readonly ChatPart[]): ChatAttachment[] {
  const attachments: ChatAttachment[] = [];
  for (const part of parts) {
    if (part.type !== "attachment") continue;
    attachments.push({
      kind: part.kind,
      name: part.name,
      mimeType: part.mimeType,
      size: part.size,
      ...(part.path === undefined ? {} : { path: part.path }),
      ...(part.frames === undefined
        ? {}
        : {
            images: part.frames.map((frame) => ({
              mimeType: frame.mimeType,
              data: base64FromDataUrl(frame.dataUrl),
            })),
          }),
      ...(part.durationSeconds === undefined ? {} : { durationSeconds: part.durationSeconds }),
      ...(part.width === undefined ? {} : { width: part.width }),
      ...(part.height === undefined ? {} : { height: part.height }),
      ...(part.downscaled === true ? { downscaled: true } : {}),
    });
  }
  return attachments;
}

/** 裸 base64 → data URL（界面渲染用；CSP 只放行 data:/blob:） */
export function toDataUrl(image: { mimeType: string; data: string }): string {
  return `data:${image.mimeType};base64,${image.data}`;
}
