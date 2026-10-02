// 会话附件库：用户拖进来的文件落到盘上，并编成模型能读的「信封 + 内容块」。
//
// ## 为什么需要落盘（而不是只把字节塞进请求）
//
// pi 只认 `TextContent | ImageContent`。图片能内联，但**视频、PDF、音频没有对应的内容块**，
// 而且就算是图片，光有字节也不够：
//   · 用户回头看这条消息时要能点开原图（给模型看的是降采样版）；
//   · 模型下一轮想「再看一眼这张图」要用 `read_image` 按路径重读；
//   · 视频只能靠抽帧 + 原文件路径，让模型在需要时自己用工具看。
// 所以每个附件一律落盘一份，路径随信封进消息。
//
// 目录形状：`<数据根>/attachments/<会话 id>/<sha1>.<ext>`。
//   · 按会话分目录 → 删会话时整目录清掉（与临时工作区同一套纪律）；
//   · 按内容寻址 → 同一张图重复贴不会存两份，重发/编辑也命中同一份；
//   · 放在数据根而不是会话工作目录 → 用户绑定了项目目录时 cwd 是项目，附件仍在
//     一个稳定的地方；工作目录里的文件模型会随手 ls/glob 到，附件不该污染那个视野。
//
// 目录会进 `sessionAllowedRoots`，所以模型可以用 `read` / `read_image` 按路径读它。
// 代价是模型**也能写**它（内核的路径守卫对读写是同一份允许根）。可接受：cwd 本来就可写，
// 而附件是用户自己选的文件、丢了还能重贴。
//
// ## 信封格式
//
// 每条附件一个文本块，紧跟着它自己的图片块：
//
//   <attachment index="1" kind="video" name="demo.mp4" mime="video/mp4" bytes="1048576"
//               path="D:\proj\demo.mp4" duration="12.4" width="1280" height="720"
//               frames="6" frame-times="1.03,3.10,..." />
//   <content>
//   The 6 images below are frames sampled from this video at the listed times.
//   </content>
//
// 为什么是这种「标签 + 属性」而不是散文：消息落盘之后，**界面要能把它还原回附件卡片**。
// 回读路径（message-mapper）拿到的只是一串内容块，唯一能区分「哪些 image 块属于哪条附件」
// 的线索就是这段文本。所以它必须是机器可解析的，而不是给人读的句子。
//
// 属性值统一做 XML 实体转义（`&` `"` `<` `>` 与换行），解析端一次反转义 ——
// Windows 路径里的反斜杠、文件名里的引号因此都不需要特例。
//
// 文本类附件把正文直接跟在 `<content>` 里（有上限），这样模型一次请求就看到内容，
// 不必为「看一眼这个文件」多跑一轮工具调用。超限则截断并如实说明。

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { dataDir } from "@/main/app/paths";
import {
  type ChatAttachment,
  type ChatAttachmentKind,
  MAX_ATTACHMENT_BYTES,
} from "@/shared/contracts/attachment";
import { sniffMediaType } from "./tools/image-meta";

/** 会话附件目录名（数据根下的子目录） */
export const ATTACHMENTS_DIR_NAME = "attachments";

/**
 * 单条附件的字节上限（64 MiB）。
 *
 * 常量住在 shared/contracts/attachment —— 渲染层要用**同一个数**挡住「拿不到磁盘路径
 * 又没有上限」的场合（那种情况把整个文件读进渲染进程只会把它拖垮）。
 * 两个数不一致的话，界面会先接受、再在发送时失败。
 */
export { MAX_ATTACHMENT_BYTES };

/** 内联进消息的文本上限（256 KiB）。再大就让模型按路径用 read 分段读 */
export const MAX_INLINE_TEXT_BYTES = 256 * 1024;

/** 内联文本的行数上限（与字节上限取先到者） */
export const MAX_INLINE_TEXT_LINES = 4000;

/** 单个附件的图片块上限（视频抽帧数）；超出只保留前 N 帧 */
export const MAX_FRAMES_PER_ATTACHMENT = 12;

/**
 * 实际发给模型的图片块。
 *
 * 截断放在这里而不是信渲染层：上限是**上下文成本**的约束，属于主进程的口径。
 * 渲染层说抽了 30 帧，这里也只放前 12 帧 —— 而信封里的 `frames` 报的就是这个数，
 * 所以界面还原出来的帧数与模型看到的帧数永远一致。
 */
export function framesForModel(attachment: ChatAttachment): { mimeType: string; data: string }[] {
  return (attachment.images ?? []).slice(0, MAX_FRAMES_PER_ATTACHMENT);
}

/** 会话附件目录：`<数据根>/attachments/<会话 id>` */
export function sessionAttachmentsDir(sessionId: string, dir: string = dataDir()): string {
  // 会话 id 来自会话库（当前是 UUID），但拼路径这一步不依赖「上游一定是 UUID」——
  // 与 paths.ts 的 workspaceDirName 同一个理由：路径拼接不能靠上游校验。
  const safe = sessionId.replace(/[^a-z0-9._-]/gi, "_");
  const name = safe === "" || /^\.+$/.test(safe) ? safe.replace(/\./g, "_") || "_" : safe;
  return path.join(dir, ATTACHMENTS_DIR_NAME, name);
}

/** 附件库根目录（会话目录的父级）；用于删会话时的清理与允许根登记 */
export function attachmentsRootDir(dir: string = dataDir()): string {
  return path.join(dir, ATTACHMENTS_DIR_NAME);
}

/** 扩展名归一：从原始文件名取，非法字符剔除；没有就用 MIME 的次类型 */
function extensionFor(name: string, mimeType: string): string {
  const fromName = path.extname(name).replace(/^\./, "");
  if (/^[a-z0-9]{1,12}$/i.test(fromName)) return fromName.toLowerCase();
  const sub = mimeType.split("/")[1]?.split(";")[0]?.trim() ?? "";
  return /^[a-z0-9.+-]{1,12}$/i.test(sub) ? sub.toLowerCase() : "bin";
}

/**
 * 附件的字节来源解析。
 *
 * `path` 优先：拖拽与文件选择器都能给出真实路径，主进程自己读盘比让渲染层先 base64
 * 一遍再走 IPC 省一次全量拷贝（一个 200 MB 的视频差别是秒级的）。
 * 重新生成 / 编辑重发时走的也是这条路 —— 渲染层手里只有路径（字节早就不在内存里了）。
 */
export async function readAttachmentBytes(attachment: ChatAttachment): Promise<Buffer> {
  const sourcePath = attachment.path?.trim();
  if (sourcePath !== undefined && sourcePath !== "") {
    const bytes = await readFile(sourcePath).catch((error: unknown) => {
      throw new Error(
        `读取附件失败 ${sourcePath}：${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return bytes;
  }
  const data = attachment.data;
  if (data === undefined || data === "") {
    throw new Error(`附件「${attachment.name}」既没有路径也没有内容，无法保存`);
  }
  return Buffer.from(data, "base64");
}

/** 落盘结果：绝对路径 + 实际字节数 */
export interface StoredAttachment {
  path: string;
  bytes: number;
}

/** 字节 → 会话附件目录里的一个文件（内容寻址，幂等） */
export async function storeAttachmentBytes(
  sessionId: string,
  attachment: ChatAttachment,
  bytes: Buffer,
  dir: string = dataDir(),
): Promise<StoredAttachment> {
  if (bytes.byteLength === 0) throw new Error(`附件「${attachment.name}」是空文件`);
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `附件「${attachment.name}」有 ${bytes.byteLength} 字节，超过 ${MAX_ATTACHMENT_BYTES} 字节的上限`,
    );
  }
  const target = sessionAttachmentsDir(sessionId, dir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  const digest = createHash("sha1").update(bytes).digest("hex");
  const file = path.join(target, `${digest}.${extensionFor(attachment.name, attachment.mimeType)}`);
  // 已存在即命中同一份内容（内容寻址的幂等写入）；不必比较字节
  await writeFile(file, bytes, { flag: "wx" }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  });
  return { path: file, bytes: bytes.byteLength };
}

/**
 * 把一条附件落到会话附件目录，返回它的绝对路径。
 *
 * 文件名是**内容摘要 + 原扩展名**：同一张图重复贴、重新生成、编辑重发都命中同一个文件，
 * 不会每发一次就多存一份。原文件名只进信封（给模型看），不进路径 —— 用户的文件名可能
 * 带空格、中文、重名，拿它当路径会在各个平台上出各种意外。
 */
export async function storeAttachment(
  sessionId: string,
  attachment: ChatAttachment,
  dir: string = dataDir(),
): Promise<StoredAttachment> {
  return storeAttachmentBytes(sessionId, attachment, await readAttachmentBytes(attachment), dir);
}

/**
 * 用磁盘上的字节补齐附件里缺的部分。
 *
 * 这条路径服务的是**重新生成 / 编辑重发**：那时渲染层只有一条 `AttachmentPart`
 * （名字、路径、读数），模型要的字节早就不在内存里了。缺什么补什么：
 *   · 图片缺 `images` → 用原文件当那个 image 块（落盘的就是原图，所以与原次发送一致）；
 *   · 文本缺 `text` → 按 UTF-8 读出来。
 *
 * **视频补不了**：抽帧要解码器，主进程里没有。那种情况下帧数为 0，信封会如实说明
 * 「这次没有抽帧」，而不是假装看到了视频。
 */
export function completeFromBytes(attachment: ChatAttachment, bytes: Buffer): ChatAttachment {
  if (attachment.kind === "image" && (attachment.images?.length ?? 0) === 0) {
    const sniffed = sniffMediaType(bytes);
    const mimeType =
      sniffed ?? (attachment.mimeType.startsWith("image/") ? attachment.mimeType : "image/png");
    return { ...attachment, images: [{ mimeType, data: bytes.toString("base64") }] };
  }
  if (attachment.kind === "text" && (attachment.text ?? "") === "") {
    return { ...attachment, text: bytes.toString("utf8") };
  }
  return attachment;
}

/** 清掉某个会话的整个附件目录（删会话时调用） */
export async function removeSessionAttachments(
  sessionId: string,
  dir: string = dataDir(),
): Promise<void> {
  try {
    await rm(sessionAttachmentsDir(sessionId, dir), { recursive: true, force: true });
  } catch (error) {
    console.warn(`清理会话附件目录失败 ${sessionId}: ${String(error)}`);
  }
}

/** Copy only attachment envelopes referenced by the fork, preserving the rest of each message. */
export function createAttachmentForkCopier(sourceId: string, destinationId: string, dir: string) {
  const sourceRoot = path.resolve(sessionAttachmentsDir(sourceId, dir));
  const copied = new Map<string, Promise<StoredAttachment>>();
  const copy = (envelope: AttachmentEnvelope): Promise<StoredAttachment> => {
    const candidate = path.resolve(envelope.path);
    const relative = path.relative(sourceRoot, candidate);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".."
    ) {
      throw new Error(`附件不属于源会话：${envelope.path}`);
    }
    let pending = copied.get(candidate);
    if (!pending) {
      pending = (async () => {
        const [root, file] = await Promise.all([realpath(sourceRoot), realpath(candidate)]);
        const resolved = path.relative(root, file);
        if (
          !resolved ||
          path.isAbsolute(resolved) ||
          resolved.startsWith(`..${path.sep}`) ||
          resolved === ".."
        ) {
          throw new Error(`附件链接超出源会话目录：${envelope.path}`);
        }
        const info = await stat(file);
        if (!info.isFile() || info.size > MAX_ATTACHMENT_BYTES)
          throw new Error(`无效的会话附件：${envelope.path}`);
        return storeAttachmentBytes(
          destinationId,
          {
            kind: envelope.kind,
            name: envelope.name,
            mimeType: envelope.mimeType,
            size: info.size,
          },
          await readFile(file),
          dir,
        );
      })();
      copied.set(candidate, pending);
    }
    return pending;
  };
  const rewrite = async (text: string): Promise<string> => {
    const envelope = parseAttachmentEnvelope(text);
    if (!envelope) return text;
    const stored = await copy(envelope);
    return text
      .replace(/\bpath="[^"]*"/, () => `path="${escapeAttr(stored.path)}"`)
      .replace(/\bbytes="[^"]*"/, () => `bytes="${stored.bytes}"`);
  };
  return async (messages: readonly Message[]): Promise<Message[]> =>
    Promise.all(
      messages.map(async (message) => {
        if (message.role !== "user") return message;
        if (typeof message.content === "string")
          return { ...message, content: await rewrite(message.content) };
        return {
          ...message,
          content: await Promise.all(
            message.content.map(async (block) =>
              block.type === "text" ? { ...block, text: await rewrite(block.text) } : block,
            ),
          ),
        };
      }),
    );
}

// ==================== 信封编解码 ====================

/** 信封标签名；解析端按它认人 */
export const ATTACHMENT_TAG = "attachment";

const ATTR_ESCAPES: readonly [RegExp, string][] = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/\r?\n/g, "&#10;"],
];

const ATTR_UNESCAPES: readonly [RegExp, string][] = [
  [/&#10;/g, "\n"],
  [/&quot;/g, '"'],
  [/&gt;/g, ">"],
  [/&lt;/g, "<"],
  [/&amp;/g, "&"],
];

function escapeAttr(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ATTR_ESCAPES) out = out.replace(pattern, replacement);
  return out;
}

function unescapeAttr(value: string): string {
  let out = value;
  for (const [pattern, replacement] of ATTR_UNESCAPES) out = out.replace(pattern, replacement);
  return out;
}

/** 信封里的读数（全部可选，缺省即不写那一项） */
export interface AttachmentEnvelope {
  index: number;
  kind: ChatAttachmentKind;
  name: string;
  mimeType: string;
  bytes: number;
  path: string;
  /** 模型要看的图片块数量（图片=1，视频=抽帧数，其余=0） */
  frames: number;
  frameTimes?: number[];
  durationSeconds?: number;
  width?: number;
  height?: number;
  totalLines?: number;
  textTruncated?: boolean;
  downscaled?: boolean;
}

function attr(source: string, key: string): string | undefined {
  const match = new RegExp(`\\b${key}="([^"]*)"`).exec(source);
  return match?.[1] === undefined ? undefined : unescapeAttr(match[1]);
}

function attrNumber(source: string, key: string): number | undefined {
  const raw = attr(source, key);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * 把一条附件编成给模型的文本块。
 *
 * 形状：自闭合标签 + 换行 + `<content>` 段（只有需要给正文/说明时才写）。
 * 说明句按类别写死，不自由发挥 —— 模型对「这几张图是抽帧」和「这是原图」的判断
 * 完全依赖这句话，措辞一飘它就会以为看到的是完整视频。
 */
export function buildAttachmentEnvelope(
  index: number,
  stored: StoredAttachment,
  attachment: ChatAttachment,
): string {
  const kind = attachment.kind;
  const frames = framesForModel(attachment).length;
  /**
   * 文本正文的截断由**主进程**决定，不采信渲染层的 `textTruncated` / `totalLines`：
   * 上限是上下文成本的约束，口径只能有一份（渲染层那份只是给 Composer 做提示用的）。
   */
  const inline = kind === "text" ? truncateText(attachment.text ?? "") : null;
  const parts: string[] = [
    `index="${index}"`,
    `kind="${kind}"`,
    `name="${escapeAttr(attachment.name)}"`,
    `mime="${escapeAttr(attachment.mimeType)}"`,
    `bytes="${stored.bytes}"`,
    `path="${escapeAttr(stored.path)}"`,
    `frames="${frames}"`,
  ];
  if (attachment.width !== undefined && attachment.height !== undefined) {
    parts.push(`width="${attachment.width}"`, `height="${attachment.height}"`);
  }
  if (attachment.durationSeconds !== undefined) {
    parts.push(`duration="${attachment.durationSeconds.toFixed(2)}"`);
  }
  if (attachment.frameTimes !== undefined && attachment.frameTimes.length > 0) {
    parts.push(
      `frame-times="${attachment.frameTimes
        .slice(0, MAX_FRAMES_PER_ATTACHMENT)
        .map((t) => t.toFixed(2))
        .join(",")}"`,
    );
  }
  if (inline !== null && inline.text !== "") parts.push(`lines="${inline.totalLines}"`);
  if (inline?.truncated === true) parts.push(`truncated="true"`);
  if (attachment.downscaled === true) parts.push(`downscaled="true"`);

  const body = attachmentBody(attachment, frames, inline);
  const tag = `<${ATTACHMENT_TAG} ${parts.join(" ")} />`;
  return body === undefined ? tag : `${tag}\n<content>\n${body}\n</content>`;
}

/** 信封正文：按类别给模型一段说明（文本附件则连正文一起给） */
function attachmentBody(
  attachment: ChatAttachment,
  frames: number,
  inline: { text: string; truncated: boolean; totalLines: number } | null,
): string | undefined {
  switch (attachment.kind) {
    case "image": {
      const notes = [
        "The image below is this file, sent so you can look at it.",
        attachment.downscaled === true
          ? "It was downscaled before being sent — use the path above with read_image if you need the original resolution."
          : undefined,
      ];
      return notes.filter((line): line is string => line !== undefined).join(" ");
    }
    case "video": {
      const seconds =
        attachment.durationSeconds === undefined
          ? "unknown duration"
          : `${attachment.durationSeconds.toFixed(1)}s`;
      /**
       * 帧数为 0 是**真实存在的分支**：重新生成 / 编辑重发时渲染层手里只有路径，
       * 而主进程没有视频解码器、抽不出帧。这时必须明说「这次没抽帧」——
       * 照原样说「下面这 0 张图是抽帧」会让模型以为视频是空的。
       */
      if (frames === 0) {
        return [
          `This video (${seconds}) could not be sampled into frames for this request.`,
          "Its file is at the path above — use a tool if you need its content, and tell the user" +
            " if the answer requires actually seeing it.",
        ].join(" ");
      }
      return [
        `The ${frames} image${frames === 1 ? "" : "s"} below are frames sampled evenly from this video (${seconds}).`,
        "You are not seeing the whole video: motion between the frames, audio and fine detail are not available to you.",
        "Say so if the answer depends on something only a full playback would show.",
        "The video file itself is at the path above.",
      ].join(" ");
    }
    case "text": {
      if (inline === null || inline.text === "") return undefined;
      const notice = inline.truncated
        ? `\n\n[truncated: this file has ${inline.totalLines} lines in total; ` +
          "use read with an offset to continue]"
        : "";
      return `${inline.text}${notice}`;
    }
    case "file":
      return [
        "This file's content is not inlined because its format has no direct representation for you.",
        "The path above is readable — pick the tool that fits (read for text, read_image for images," +
          " or a plugin/MCP tool for its format) if you need its contents.",
      ].join(" ");
  }
}

/** 一个文本块是不是附件信封（回读时按这个判据切分内容块） */
export function isAttachmentEnvelope(text: string): boolean {
  return text.startsWith(`<${ATTACHMENT_TAG} `);
}

/**
 * 解析一条信封文本块。
 *
 * **失败一律返回 null**（当成普通文本）而不是抛错：这段文本最终来自会话库，
 * 旧会话、被截断的历史、用户手打的一段长得像标签的话都可能出现在这里 ——
 * 解析失败只该让那条消息退回「纯文本」的显示，不该让整条会话读不出来。
 */
export function parseAttachmentEnvelope(text: string): AttachmentEnvelope | null {
  if (!isAttachmentEnvelope(text)) return null;
  const lineEnd = text.indexOf("\n");
  const tagLine = lineEnd === -1 ? text : text.slice(0, lineEnd);
  if (!/\/>\s*$/.test(tagLine)) return null;

  const index = attrNumber(tagLine, "index");
  const kind = attr(tagLine, "kind");
  const name = attr(tagLine, "name");
  const mimeType = attr(tagLine, "mime");
  const bytes = attrNumber(tagLine, "bytes");
  const storedPath = attr(tagLine, "path");
  if (index === undefined || kind === undefined || name === undefined) return null;
  if (mimeType === undefined || bytes === undefined || storedPath === undefined) return null;
  if (kind !== "image" && kind !== "video" && kind !== "text" && kind !== "file") return null;

  const frameTimes = attr(tagLine, "frame-times")
    ?.split(",")
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  return {
    index,
    kind,
    name,
    mimeType,
    bytes,
    path: storedPath,
    frames: attrNumber(tagLine, "frames") ?? 0,
    ...(frameTimes === undefined || frameTimes.length === 0 ? {} : { frameTimes }),
    ...(attrNumber(tagLine, "duration") === undefined
      ? {}
      : { durationSeconds: attrNumber(tagLine, "duration") }),
    ...(attrNumber(tagLine, "width") === undefined ? {} : { width: attrNumber(tagLine, "width") }),
    ...(attrNumber(tagLine, "height") === undefined
      ? {}
      : { height: attrNumber(tagLine, "height") }),
    ...(attrNumber(tagLine, "lines") === undefined
      ? {}
      : { totalLines: attrNumber(tagLine, "lines") }),
    ...(attr(tagLine, "truncated") === "true" ? { textTruncated: true } : {}),
    ...(attr(tagLine, "downscaled") === "true" ? { downscaled: true } : {}),
  };
}

/**
 * 按上限截断文本正文。
 *
 * 两个上限取先到者（字节 / 行数）：一个 5 MB 的单行 minified JS 与一个 20 万行的日志
 * 都要挡住。截断位置只按整行切，不在多字节字符中间断。
 */
export function truncateText(text: string): {
  text: string;
  truncated: boolean;
  totalLines: number;
} {
  const lines = text.split("\n");
  const totalLines = lines.length;
  let truncated = false;
  let kept = lines;
  if (lines.length > MAX_INLINE_TEXT_LINES) {
    kept = lines.slice(0, MAX_INLINE_TEXT_LINES);
    truncated = true;
  }
  let joined = kept.join("\n");
  if (Buffer.byteLength(joined, "utf8") > MAX_INLINE_TEXT_BYTES) {
    // 按行回退到字节上限以内，避免在多字节字符中间切
    let used = 0;
    const within: string[] = [];
    for (const line of kept) {
      const size = Buffer.byteLength(line, "utf8") + 1;
      if (used + size > MAX_INLINE_TEXT_BYTES) break;
      within.push(line);
      used += size;
    }
    joined = within.join("\n");
    truncated = true;
  }
  return { text: joined, truncated, totalLines };
}

/** 用户消息的内容块（pi 只认这两种） */
export type UserContentBlock = TextContent | ImageContent;

/**
 * 把一次发送的「文本 + 附件」编成 pi 的用户消息内容块。
 *
 * 顺序是**交错**的：每条附件一个信封文本块，紧跟它自己的图片块。这样「哪些图属于哪条
 * 附件」在消息里是**结构**而不是推断 —— 回读时（message-mapper 的 mapUserParts）
 * 只需按 `frames` 数往后数，不必猜。全放末尾的话，六帧视频与四张图混在一起就只能靠
 * 信封里的下标去对，任何一次落盘异常都会让后面全部错位。
 *
 * 落盘在这里发生（而不是渲染层）：路径必须由主进程给出，模型才拿得到一个可信的绝对路径；
 * 而且失败要能把整次发送判为失败，而不是让消息带着一个假的路径发出去。
 */
export async function buildUserContent(
  sessionId: string,
  text: string,
  attachments: readonly ChatAttachment[] | undefined,
  dir: string = dataDir(),
): Promise<UserContentBlock[]> {
  const content: UserContentBlock[] = [];
  if (text.length > 0) content.push({ type: "text", text });
  let index = 0;
  for (const incoming of attachments ?? []) {
    index += 1;
    const bytes = await readAttachmentBytes(incoming);
    const stored = await storeAttachmentBytes(sessionId, incoming, bytes, dir);
    const attachment = completeFromBytes(incoming, bytes);
    content.push({ type: "text", text: buildAttachmentEnvelope(index, stored, attachment) });
    for (const frame of framesForModel(attachment)) {
      content.push({ type: "image", data: frame.data, mimeType: frame.mimeType });
    }
  }
  /**
   * 全空时给一个空文本块，保持与旧行为一致。
   *
   * 旧路径是 `lane.prompt(text, images)`：text 为空且无图时内核以
   * `InvalidMessage{reason:"empty"}` 拒收。这里拼不出任何块时给一个空文本块，
   * 让内核走同一条校验（而不是我们自己造一条内容为空的 user 消息 —— 那对供应商
   * 是不合法的请求体）。渲染层的发送键本来就要求「有文本或有附件」，走不到这里。
   */
  if (content.length === 0) content.push({ type: "text", text: "" });
  return content;
}
