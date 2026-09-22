// 图片文件的**元数据**解析：从字节里嗅出真实格式、读出像素尺寸。
//
// 全是纯函数（只吃 Uint8Array、只回值、不碰文件系统），所以能直接喂构造好的字节做单测 ——
// 与 tools/jobs.ts 的 DrainBuffer、tools/read.ts 的 numberLines 同一个口径。
//
// **为什么读魔数而不是信任扩展名**：`image.png` 完全可能是一个改了名的 JPEG，或者干脆是
// 一坨别的东西。扩展名只用来「快速拒绝明显不是图片的路径」，真正的判定必须看字节 ——
// 这与 DSH 的 read_image 分工一致（那边由附件服务做完整解码，这里由魔数 + 头部解析承担）。
//
// **为什么不引图片库**：只需要格式与尺寸两个读数，而四家的头部结构都很小且稳定。
// 引一个 image-size / sharp 会把原生依赖带进主进程打包（sharp 尤其重），
// 而这里的解析全是几十行、可测、失败的后果只是「尺寸未知」而不是「读不出图」。
// 工具的说明里也明确要求模型**不要**为了看图去装图片库。
//
// 解析不出来时一律返回 undefined，**绝不编一个尺寸**：调用方要么如实说「未知」，
// 要么什么都不显示。一个猜出来的 width 比没有更糟 —— 模型会拿它去算坐标。

/** 支持的图片格式：与 DSH 的 read_image 同一份名单 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** 扩展名 → 声明的格式；只用于「快速判断这个路径像不像图片」 */
const EXTENSION_MEDIA_TYPES: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/**
 * 按扩展名声明格式。
 *
 * 刻意**不含 bmp**（内核的 read 认它）：主流模型不接受 BMP 输入，放进来只会让模型
 * 读到一张发不出去的图；DSH 的 read_image 同样只收这四种。
 */
export function mediaTypeForPath(filePath: string): ImageMediaType | undefined {
  const match = /\.[^./\\]+$/.exec(filePath);
  if (match === null) return undefined;
  return EXTENSION_MEDIA_TYPES[match[0].toLowerCase()];
}

/** 该扩展名是不是「声称自己是图片但不在支持名单里」（如 .bmp / .tiff / .svg） */
export function declaredUnsupportedImageExtension(filePath: string): string | undefined {
  const match = /\.[^./\\]+$/.exec(filePath);
  if (match === null) return undefined;
  const extension = match[0].toLowerCase();
  if (EXTENSION_MEDIA_TYPES[extension] !== undefined) return undefined;
  // 只报「一眼就像图片」的那些扩展名；`.txt` / `.ts` 走的是「内容不是图片」那条诊断，
  // 拿扩展名去说事会误导模型（把 a.txt 改名成 a.png 也救不了）
  return UNSUPPORTED_IMAGE_EXTENSIONS.has(extension) ? extension : undefined;
}

/** 常见但不支持的图片扩展名：命中时给一句「换成 PNG/JPEG/WebP/GIF」的具体指引 */
const UNSUPPORTED_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
  ".avif",
  ".heic",
  ".heif",
  ".ico",
  ".psd",
]);

function matchesBytes(data: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (data.byteLength < offset + expected.length) return false;
  return expected.every((byte, index) => data[offset + index] === byte);
}

function matchesAscii(data: Uint8Array, offset: number, value: string): boolean {
  if (data.byteLength < offset + value.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (data[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

/**
 * 按**内容**判定格式。
 *
 * 判据顺序与 DSH 的 sniffImageMediaType 一致：PNG → JPEG → GIF → WebP。
 * PNG 那个签名有 8 字节，是最不容易误判的一个，放最前面。
 */
export function sniffMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (matchesBytes(data, 0, PNG_SIGNATURE)) return "image/png";
  if (matchesBytes(data, 0, JPEG_SIGNATURE)) return "image/jpeg";
  if (matchesAscii(data, 0, "GIF87a") || matchesAscii(data, 0, "GIF89a")) return "image/gif";
  if (matchesAscii(data, 0, "RIFF") && matchesAscii(data, 8, "WEBP")) return "image/webp";
  return undefined;
}

/** 像素尺寸 */
export interface ImageDimensions {
  width: number;
  height: number;
}

function readUint16LE(data: Uint8Array, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

function readUint32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] ?? 0) * 0x1000000 +
      ((data[offset + 1] ?? 0) << 16) +
      ((data[offset + 2] ?? 0) << 8) +
      (data[offset + 3] ?? 0)) >>>
    0
  );
}

/** 尺寸必须是正数才作数：0 与负数都是坏数据，不能当读数用 */
function dimensions(width: number, height: number): ImageDimensions | undefined {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined;
  if (width <= 0 || height <= 0) return undefined;
  return { width, height };
}

/**
 * PNG：签名 8 字节 + 块长度 4 字节 + "IHDR" 4 字节，随后就是宽高各 4 字节（大端）。
 *
 * 只认标准 IHDR：签名之后紧跟的必须是长度为 13 的 IHDR 块，
 * 否则这份字节不是良构 PNG（此时返回 undefined，让调用方说「读不出尺寸」）。
 */
function pngDimensions(data: Uint8Array): ImageDimensions | undefined {
  if (!matchesBytes(data, 0, PNG_SIGNATURE)) return undefined;
  if (!matchesAscii(data, 12, "IHDR")) return undefined;
  if (readUint32BE(data, 8) !== 13) return undefined;
  if (data.byteLength < 24) return undefined;
  return dimensions(readUint32BE(data, 16), readUint32BE(data, 20));
}

/** GIF：逻辑屏幕宽高各 2 字节（小端），在 6 字节签名之后 */
function gifDimensions(data: Uint8Array): ImageDimensions | undefined {
  const header = matchesAscii(data, 0, "GIF87a") || matchesAscii(data, 0, "GIF89a");
  if (!header || data.byteLength < 10) return undefined;
  return dimensions(readUint16LE(data, 6), readUint16LE(data, 8));
}

/**
 * JPEG：扫段找 SOF（Start Of Frame）。
 *
 * 布局是「FF marker + 2 字节段长 + 段体」，只有 SOF 段里带尺寸。
 * 必须**逐段跳过**而不是全文搜 `FFC0`：段体里完全可能出现那个字节序列（比如缩略图数据），
 * 盲搜会读出一个错的尺寸。
 *
 * SOF 名单刻意排除了 `C4`（DHT，霍夫曼表）、`C8`（JPG）与 `CC`（DAC）——
 * 它们落在 C0~CF 这一段里但不是帧头，按帧头解析会读出错的值。
 */
function jpegDimensions(data: Uint8Array): ImageDimensions | undefined {
  if (!matchesBytes(data, 0, JPEG_SIGNATURE)) return undefined;

  let offset = 2;
  while (offset + 9 <= data.byteLength) {
    if (data[offset] !== 0xff) {
      // 不在段边界上：这份字节的结构已经不是我们能可靠跟随的了，停手而不是猜
      return undefined;
    }
    const marker = data[offset + 1] ?? 0;
    // 填充字节（FF FF …）与无段体的独立标记：只前进，不解析
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = ((data[offset + 2] ?? 0) << 8) | (data[offset + 3] ?? 0);
    // 段长含它自己那 2 字节，因此至少是 2；小于 2 会让 offset 原地踏步（死循环）
    if (length < 2) return undefined;

    const isSof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      // SOF 段：长度(2) + 精度(1) + 高(2) + 宽(2)
      if (offset + 9 > data.byteLength) return undefined;
      return dimensions(
        ((data[offset + 7] ?? 0) << 8) | (data[offset + 8] ?? 0),
        ((data[offset + 5] ?? 0) << 8) | (data[offset + 6] ?? 0),
      );
    }
    // SOS(DA) 之后是熵编码数据，再往后扫是纯碰运气：到这里就停
    if (marker === 0xda) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/**
 * WebP：RIFF 容器，三种编码各有一种放尺寸的方式。
 *
 * - `VP8 `（有损）：帧头里 14 位宽 + 14 位高，位于块体偏移 6/8；
 * - `VP8L`（无损）：块体偏移 1 起是 14 位宽-1 与 14 位高-1，按位打包；
 * - `VP8X`（扩展）：画布宽高各 3 字节（小端、存的是「减一」）。
 *
 * 三种都要认：只认 VP8 会让所有无损 WebP 报「尺寸未知」，
 * 而那正是截图工具最常产出的格式之一。
 */
function webpDimensions(data: Uint8Array): ImageDimensions | undefined {
  if (!matchesAscii(data, 0, "RIFF") || !matchesAscii(data, 8, "WEBP")) return undefined;
  if (data.byteLength < 16) return undefined;

  if (matchesAscii(data, 12, "VP8X")) {
    if (data.byteLength < 30) return undefined;
    const width = 1 + ((data[24] ?? 0) | ((data[25] ?? 0) << 8) | ((data[26] ?? 0) << 16));
    const height = 1 + ((data[27] ?? 0) | ((data[28] ?? 0) << 8) | ((data[29] ?? 0) << 16));
    return dimensions(width, height);
  }

  if (matchesAscii(data, 12, "VP8L")) {
    if (data.byteLength < 25 || (data[20] ?? 0) !== 0x2f) return undefined;
    // 14 位宽-1（从 byte21 低位起）+ 14 位高-1
    const bits =
      (data[21] ?? 0) | ((data[22] ?? 0) << 8) | ((data[23] ?? 0) << 16) | ((data[24] ?? 0) << 24);
    const width = 1 + (bits & 0x3fff);
    const height = 1 + ((bits >> 14) & 0x3fff);
    return dimensions(width, height);
  }

  if (matchesAscii(data, 12, "VP8 ")) {
    // 帧头以 9d 01 2a 起头，随后宽高各 2 字节（小端，各取低 14 位）
    if (data.byteLength < 30) return undefined;
    if ((data[23] ?? 0) !== 0x9d || (data[24] ?? 0) !== 0x01 || (data[25] ?? 0) !== 0x2a) {
      return undefined;
    }
    return dimensions(readUint16LE(data, 26) & 0x3fff, readUint16LE(data, 28) & 0x3fff);
  }

  return undefined;
}

/**
 * 按格式读像素尺寸；读不出来返回 undefined（调用方如实说「未知」，不猜）。
 *
 * 分派用**传入的格式**而不是重新嗅一遍：调用方已经决定要用哪份格式了
 *（可能是扩展名声明的、也可能是魔数嗅出来的），这里跟着走就不会出现两边不一致。
 */
export function imageDimensions(
  data: Uint8Array,
  mediaType: ImageMediaType,
): ImageDimensions | undefined {
  switch (mediaType) {
    case "image/png":
      return pngDimensions(data);
    case "image/jpeg":
      return jpegDimensions(data);
    case "image/gif":
      return gifDimensions(data);
    case "image/webp":
      return webpDimensions(data);
  }
}
