/**
 * 图片元数据解析的单测：格式嗅探 + 四种格式的尺寸读取。
 *
 * 这里**不读真实图片文件**，而是手工拼最小的合法头部 —— 各格式的头部结构都很小，
 * 拼出来才知道自己验的是哪几个字节。用真实文件反而说不清「失败时是解析错了还是文件不对」。
 *
 * 每个格式都配了「坏数据」用例：解析不出来必须返回 undefined，**绝不猜一个尺寸**。
 * 猜出来的 width 比没有更糟 —— 模型会拿它去算坐标。
 */
import { describe, expect, it } from "vitest";
import {
  declaredUnsupportedImageExtension,
  imageDimensions,
  mediaTypeForPath,
  sniffMediaType,
} from "./image-meta";

/** PNG：8 字节签名 + 长度 13 + "IHDR" + 宽 + 高 */
function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  bytes.set(
    [(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff],
    20,
  );
  return bytes;
}

/** GIF：签名 + 逻辑屏幕宽高（小端 2 字节） */
function gif(width: number, height: number, version = "89a"): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(
    [..."GIF"].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [..."89a"].map((c) => c.charCodeAt(0)),
    3,
  );
  bytes.set([width & 0xff, (width >> 8) & 0xff], 6);
  bytes.set([height & 0xff, (height >> 8) & 0xff], 8);
  void version;
  return bytes;
}

/** JPEG：SOI + 一个 APP0 段 + 一个 SOF0 段（带尺寸） */
function jpeg(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(2 + 4 + 2 + 8 + 11);
  let offset = 0;
  bytes.set([0xff, 0xd8], offset);
  offset += 2;
  // APP0（FFE0）+ 长度 4（含自身 2 字节）+ 2 字节段体
  bytes.set([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00], offset);
  offset += 6;
  // SOF0（FFC0）+ 长度 11 + 精度 8 + 高 + 宽
  bytes.set([0xff, 0xc0, 0x00, 0x0b, 0x08], offset);
  bytes.set([(height >> 8) & 0xff, height & 0xff], offset + 5);
  bytes.set([(width >> 8) & 0xff, width & 0xff], offset + 7);
  return bytes;
}

/** WebP（VP8 有损）：RIFF + WEBP + "VP8 " + 块长 + 帧头 9d 01 2a + 宽高 */
function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(
    [..."RIFF"].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [..."WEBP"].map((c) => c.charCodeAt(0)),
    8,
  );
  bytes.set(
    [..."VP8 "].map((c) => c.charCodeAt(0)),
    12,
  );
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes.set([width & 0xff, (width >> 8) & 0xff], 26);
  bytes.set([height & 0xff, (height >> 8) & 0xff], 28);
  return bytes;
}

/** WebP（VP8X 扩展）：画布宽高各 3 字节（存的是减一） */
function webpExtended(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set(
    [..."RIFF"].map((c) => c.charCodeAt(0)),
    0,
  );
  bytes.set(
    [..."WEBP"].map((c) => c.charCodeAt(0)),
    8,
  );
  bytes.set(
    [..."VP8X"].map((c) => c.charCodeAt(0)),
    12,
  );
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
}

describe("sniffMediaType", () => {
  it("按内容认出四种格式，不看扩展名", () => {
    expect(sniffMediaType(png(1, 1))).toBe("image/png");
    expect(sniffMediaType(jpeg(1, 1))).toBe("image/jpeg");
    expect(sniffMediaType(gif(1, 1))).toBe("image/gif");
    expect(sniffMediaType(webpLossy(1, 1))).toBe("image/webp");
  });

  it("BMP 不在支持名单里（主流模型不接受它的输入）", () => {
    const bmp = new Uint8Array([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(sniffMediaType(bmp)).toBeUndefined();
  });

  it("空字节与随便一段文本都不是图片", () => {
    expect(sniffMediaType(new Uint8Array(0))).toBeUndefined();
    expect(sniffMediaType(new TextEncoder().encode("hello world"))).toBeUndefined();
  });

  it("字节不足（截断的文件）不报错、也不误判", () => {
    const full = png(10, 10);
    for (const cut of [1, 3, 7]) {
      expect(sniffMediaType(full.slice(0, cut))).toBeUndefined();
    }
  });
});

describe("mediaTypeForPath", () => {
  it("认四种扩展名，大小写不敏感", () => {
    expect(mediaTypeForPath("a/b.png")).toBe("image/png");
    expect(mediaTypeForPath("a/b.JPG")).toBe("image/jpeg");
    expect(mediaTypeForPath("a/b.jpeg")).toBe("image/jpeg");
    expect(mediaTypeForPath("a/b.webp")).toBe("image/webp");
    expect(mediaTypeForPath("a/b.gif")).toBe("image/gif");
  });

  it("没有扩展名时返回 undefined（无扩展名的图片靠内容嗅探）", () => {
    expect(mediaTypeForPath("a/b")).toBeUndefined();
    // 目录名里的点不算扩展名
    expect(mediaTypeForPath("a.b/c")).toBeUndefined();
  });
});

describe("declaredUnsupportedImageExtension", () => {
  it("认得出「像图片但不支持」的扩展名，给出改名/转换的指引", () => {
    expect(declaredUnsupportedImageExtension("a/b.bmp")).toBe(".bmp");
    expect(declaredUnsupportedImageExtension("a/b.SVG")).toBe(".svg");
    expect(declaredUnsupportedImageExtension("a/b.tiff")).toBe(".tiff");
    expect(declaredUnsupportedImageExtension("a/b.heic")).toBe(".heic");
  });

  it("支持的扩展名与非图片扩展名都不算「不支持的图片」", () => {
    expect(declaredUnsupportedImageExtension("a/b.png")).toBeUndefined();
    // .txt 要把话留到「内容不是图片」那条诊断上去说 —— 拿扩展名说事会误导模型
    expect(declaredUnsupportedImageExtension("a/b.txt")).toBeUndefined();
    expect(declaredUnsupportedImageExtension("a/b")).toBeUndefined();
  });
});

describe("imageDimensions", () => {
  it("PNG 读 IHDR 里的宽高", () => {
    expect(imageDimensions(png(1920, 1080), "image/png")).toEqual({ width: 1920, height: 1080 });
  });

  it("PNG 的 IHDR 不标准时不给尺寸（不猜）", () => {
    const broken = png(100, 100);
    // 把 IHDR 改坏
    broken.set([0x58, 0x58, 0x58, 0x58], 12);
    expect(imageDimensions(broken, "image/png")).toBeUndefined();
  });

  it("GIF 读逻辑屏幕宽高（小端）", () => {
    expect(imageDimensions(gif(320, 240), "image/gif")).toEqual({ width: 320, height: 240 });
  });

  it("JPEG 跳过前面的段、从 SOF 里读宽高", () => {
    expect(imageDimensions(jpeg(800, 600), "image/jpeg")).toEqual({ width: 800, height: 600 });
  });

  it("JPEG 里段长非法（< 2）时停手，不陷入死循环", () => {
    const evil = new Uint8Array(32);
    evil.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00], 0);
    expect(imageDimensions(evil, "image/jpeg")).toBeUndefined();
  });

  it("WebP 的 VP8（有损）与 VP8X（扩展）两种都要认出来", () => {
    expect(imageDimensions(webpLossy(640, 480), "image/webp")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(webpExtended(1024, 768), "image/webp")).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("尺寸为 0 或负数时按「读不出来」处理，不当成读数返回", () => {
    expect(imageDimensions(png(0, 0), "image/png")).toBeUndefined();
    expect(imageDimensions(gif(0, 100), "image/gif")).toBeUndefined();
  });

  it("字节太短时不抛异常，返回 undefined", () => {
    expect(imageDimensions(new Uint8Array(3), "image/png")).toBeUndefined();
    expect(imageDimensions(new Uint8Array(3), "image/jpeg")).toBeUndefined();
    expect(imageDimensions(new Uint8Array(3), "image/gif")).toBeUndefined();
    expect(imageDimensions(new Uint8Array(3), "image/webp")).toBeUndefined();
  });
});
