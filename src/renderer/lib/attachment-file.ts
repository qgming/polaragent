// 把用户选中的 File 探成「模型能消费的形态」。
//
// 这一步在**渲染层**做，因为它需要 Chromium 的解码能力：
//   · 图片降采样靠 canvas（主进程里没有 canvas，也不该为了缩放塞一个图像库进去）；
//   · 视频抽帧靠 `<video>` + canvas —— 这是唯一不引第三方依赖就能真的看到视频内容的
//     办法。pi 只认 `TextContent | ImageContent`，没有 video 内容块，所以「多模态视频」
//     在本项目里就是**抽帧 + 原文件路径**：帧给模型看，路径让它需要时自己再读。
//
// 所有失败都**降级而不是抛出**：一张读不动的图、一段解不了的视频，仍然应该把文件本身
// 落盘并把路径给模型（信封里如实说明），而不是让整次发送失败。用户拖进来的东西
// 至少得能发出去。

import type { ChatAttachmentKind } from "@/shared/contracts/attachment";

/** 内联给模型的文本上限（与主进程 MAX_INLINE_TEXT_BYTES 对齐；渲染层先截一道，免得几十 MB 走 IPC） */
const MAX_PROBE_TEXT_BYTES = 256 * 1024;

/** 图片长边上限：超过就降采样。1568 是主流视觉模型的分辨率甜点，再大只是白烧 token */
const MAX_IMAGE_EDGE = 1568;

/** 单张图内联给模型的字节上限；超过就压缩（base64 之后还要 ×1.33） */
const MAX_INLINE_IMAGE_BYTES = 3.5 * 1024 * 1024;

/** 视频抽帧的帧数上限与单帧长边 */
const MAX_VIDEO_FRAMES = 8;
const MIN_VIDEO_FRAMES = 2;
const VIDEO_FRAME_EDGE = 1024;

/** 单次 seek 与整段抽帧的超时；超时就放弃抽帧，只给路径（坏文件不该把发送卡死） */
const SEEK_TIMEOUT_MS = 4000;
const FRAME_TOTAL_TIMEOUT_MS = 25_000;

/** 按扩展名认定的文本类型（浏览器给的 MIME 常常是空串，尤其拖拽与 .log/.env 这类） */
const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "mdx",
  "rst",
  "log",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "properties",
  "xml",
  "html",
  "htm",
  "svg",
  "css",
  "scss",
  "less",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "mts",
  "cts",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "swift",
  "m",
  "mm",
  "scala",
  "lua",
  "pl",
  "r",
  "jl",
  "dart",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "cljs",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "bat",
  "cmd",
  "sql",
  "graphql",
  "gql",
  "proto",
  "diff",
  "patch",
  "gitignore",
  "editorconfig",
  "dockerignore",
  "vue",
  "svelte",
  "astro",
  "ipynb",
  "tex",
  "bib",
  "makefile",
  "cmake",
  "gradle",
  "lock",
]);

/** 没有扩展名但按名字就该当文本的（大小写不敏感） */
const TEXT_FILENAMES = new Set([
  "makefile",
  "dockerfile",
  "gemfile",
  "rakefile",
  "procfile",
  "license",
  "notice",
  "readme",
  "changelog",
  "authors",
  "todo",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".env",
  ".env.local",
  ".dockerignore",
]);

/** 图片扩展名（MIME 缺失时的兜底判据） */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "heic",
  "heif",
  "tif",
  "tiff",
  "ico",
]);

/** 视频扩展名 */
const VIDEO_EXTENSIONS = new Set([
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
  "avi",
  "wmv",
  "flv",
  "mpg",
  "mpeg",
]);

/** MIME 里带这些子类型的一律当文本（`application/json`、`application/x-sh` …） */
const TEXT_APPLICATION_SUBTYPES = new Set([
  "json",
  "ld+json",
  "xml",
  "xhtml+xml",
  "javascript",
  "ecmascript",
  "x-sh",
  "x-httpd-php",
  "x-python",
  "x-ruby",
  "x-perl",
  "x-yaml",
  "yaml",
  "toml",
  "sql",
  "graphql",
  "x-ndjson",
  "ndjson",
  "rtf",
]);

/** 取扩展名（小写，不含点）；没有就返回空串 */
function extensionOf(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0) return "";
  return name.slice(at + 1).toLowerCase();
}

/** 这个文件是不是「文本」——按 MIME 与扩展名两路判断，任一路命中即可 */
export function isTextualFile(name: string, mimeType: string): boolean {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime.startsWith("application/")) {
    const sub = mime.slice("application/".length).split(";")[0]?.trim() ?? "";
    if (TEXT_APPLICATION_SUBTYPES.has(sub)) return true;
    if (sub.endsWith("+json") || sub.endsWith("+xml") || sub.endsWith("+yaml")) return true;
  }
  const lower = name.toLowerCase();
  if (TEXT_FILENAMES.has(lower)) return true;
  return TEXT_EXTENSIONS.has(extensionOf(name));
}

/**
 * 附件类别。
 *
 * MIME 与扩展名**两路都看**：拖拽与「无类型」文件常常给空 MIME（.log、.env、.mp4 都遇到过），
 * 只认 MIME 的话一个视频会被当成二进制，白白丢掉抽帧这条唯一能让模型「看到」它的路。
 *
 * SVG **算文本**（与 read_image 的描述同一口径）：它是 XML，当图片渲染出来对模型
 * 没有信息量，而当文本读出来它能真的看到路径、文字与结构。
 */
export function classifyFile(name: string, mimeType: string): ChatAttachmentKind {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(name);
  if (mime === "image/svg+xml" || extension === "svg") return "text";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(extension)) return "image";
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.has(extension)) return "video";
  if (isTextualFile(name, mimeType)) return "text";
  return "file";
}

/** File → 裸 base64（无 data: 前缀），与 pi 的 ImageContent 口径一致 */
export async function fileToBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 按上限读文本；截断只发生在整行边界，不会把一个多字节字符劈成两半 */
export async function readTextPrefix(file: Blob): Promise<{ text: string; truncated: boolean }> {
  const truncated = file.size > MAX_PROBE_TEXT_BYTES;
  const slice = truncated ? file.slice(0, MAX_PROBE_TEXT_BYTES) : file;
  const raw = await slice.text();
  if (!truncated) return { text: raw, truncated: false };
  // 截断点大概率落在某一行中间：丢掉最后那一段不完整的行
  const lastBreak = raw.lastIndexOf("\n");
  return { text: lastBreak === -1 ? raw : raw.slice(0, lastBreak), truncated: true };
}

/** 降采样/编码结果 */
export interface EncodedImage {
  mimeType: string;
  data: string;
  width: number;
  height: number;
  /** 与原图相比是否变过（尺寸或编码） */
  reencoded: boolean;
}

/** 画到 canvas 并编码成 base64 */
function encodeCanvas(
  source: CanvasImageSource,
  width: number,
  height: number,
  mimeType: string,
  quality?: number,
): EncodedImage {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("无法创建 canvas 上下文");
  context.drawImage(source, 0, 0, width, height);
  const url = canvas.toDataURL(mimeType, quality);
  const comma = url.indexOf(",");
  return {
    mimeType,
    data: comma === -1 ? "" : url.slice(comma + 1),
    width,
    height,
    reencoded: true,
  };
}

/**
 * 图片 → 给模型的字节。
 *
 * 策略：
 *   1. 本来就在限制内（长边 ≤ MAX_IMAGE_EDGE 且字节 ≤ MAX_INLINE_IMAGE_BYTES）→ 原样发，
 *      保真度最高，也不做一次无谓的重编码；
 *   2. 否则缩到长边以内。PNG 截图（文字为主）优先保持 PNG —— JPEG 的振铃会让小字变糊，
 *      而截图恰恰是用户最常拖进来的图；像素太多（重编码 PNG 会很大）才退到 JPEG；
 *   3. 编码后仍然超字节上限就继续缩（最多两次），再不行降质量。
 *
 * 读不出来（不是图片、解码失败）时返回 null，调用方退回「按文件落盘 + 给路径」。
 */
export async function encodeImageForModel(file: File): Promise<EncodedImage | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const { width, height } = bitmap;
    if (width === 0 || height === 0) return null;
    const longest = Math.max(width, height);
    if (longest <= MAX_IMAGE_EDGE && file.size <= MAX_INLINE_IMAGE_BYTES) {
      const mimeType = file.type === "" ? "image/png" : file.type;
      return { mimeType, data: await fileToBase64(file), width, height, reencoded: false };
    }

    const prefersPng = file.type === "image/png";
    let edge = Math.min(longest, MAX_IMAGE_EDGE);
    let last: EncodedImage | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scale = edge / longest;
      const targetWidth = Math.max(1, Math.round(width * scale));
      const targetHeight = Math.max(1, Math.round(height * scale));
      const pixels = targetWidth * targetHeight;
      const usePng = prefersPng && pixels <= 2_000_000 && attempt === 0;
      last = encodeCanvas(
        bitmap,
        targetWidth,
        targetHeight,
        usePng ? "image/png" : "image/jpeg",
        usePng ? undefined : attempt === 0 ? 0.85 : 0.72,
      );
      // base64 的实际字节数按 3/4 估；留一点余量给信封与其它块
      const estimated = (last.data.length * 3) / 4;
      if (estimated <= MAX_INLINE_IMAGE_BYTES) return last;
      edge = Math.round(edge * 0.7);
    }
    return last;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** 视频抽帧结果 */
export interface VideoFrames {
  frames: { mimeType: string; data: string }[];
  frameTimes: number[];
  durationSeconds: number;
  width: number;
  height: number;
}

/** 等到元素发出指定事件；超时或出错都 reject，由调用方兜底 */
function waitForEvent(target: HTMLVideoElement, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待 ${event} 超时`));
    }, timeoutMs);
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("视频解码失败"));
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      target.removeEventListener(event, onEvent);
      target.removeEventListener("error", onError);
    };
    target.addEventListener(event, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

/** 按时长决定抽几帧：太短的视频抽 2 帧就够，长视频最多 8 帧 */
function frameCountFor(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return MIN_VIDEO_FRAMES;
  return Math.min(MAX_VIDEO_FRAMES, Math.max(MIN_VIDEO_FRAMES, Math.ceil(duration / 3)));
}

/**
 * 视频抽帧：按时间均匀取 N 帧，缩到 VIDEO_FRAME_EDGE 以内，编码成 JPEG。
 *
 * 抽帧点是 `(i + 0.5) / N * duration` —— 每段的**中点**而不是端点：端点常常是
 * 黑场、台标或片尾，中点更可能落在真实内容上。跳过第一帧也顺带避开了不少封面帧。
 *
 * 全程有超时；任何一步失败都返回 null（调用方只给路径）。一段 4K HEVC 在没装解码器的
 * 机器上会一直不出 `loadedmetadata`，没有超时就会把发送卡在那里。
 */
export async function extractVideoFrames(file: File): Promise<VideoFrames | null> {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  // 挂进文档再解码：脱离文档的 <video> 在部分路径上不会真的驱动解码器
  video.style.cssText =
    "position:fixed;left:-10000px;top:0;width:2px;height:2px;opacity:0;pointer-events:none";
  video.src = url;
  document.body.appendChild(video);
  const deadline = Date.now() + FRAME_TOTAL_TIMEOUT_MS;
  try {
    await waitForEvent(video, "loadedmetadata", SEEK_TIMEOUT_MS);
    const duration = video.duration;
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (width === 0 || height === 0) return null;
    const count = frameCountFor(duration);
    const longest = Math.max(width, height);
    const scale = longest > VIDEO_FRAME_EDGE ? VIDEO_FRAME_EDGE / longest : 1;
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));

    const frames: { mimeType: string; data: string }[] = [];
    const frameTimes: number[] = [];
    for (let i = 0; i < count; i += 1) {
      if (Date.now() > deadline) break;
      const at = Number.isFinite(duration) && duration > 0 ? ((i + 0.5) / count) * duration : 0;
      video.currentTime = at;
      await waitForEvent(video, "seeked", SEEK_TIMEOUT_MS);
      const encoded = encodeCanvas(video, targetWidth, targetHeight, "image/jpeg", 0.72);
      frames.push({ mimeType: encoded.mimeType, data: encoded.data });
      frameTimes.push(at);
    }
    if (frames.length === 0) return null;
    return {
      frames,
      frameTimes,
      durationSeconds: Number.isFinite(duration) ? duration : 0,
      width,
      height,
    };
  } catch {
    return null;
  } finally {
    video.removeAttribute("src");
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
}
