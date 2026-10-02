/**
 * 附件探测的渲染层单测（ui project / jsdom）。
 *
 * 覆盖两件事：
 *   1. **分类**（图片 / 视频 / 文本 / 其他）—— 判错了整条链路都会走偏：一张 PNG 被当成
 *      二进制就只给路径、模型看不到图；一个 .log 被当成二进制就把内容浪费了。
 *   2. **视频抽帧**的循环 —— 这是「多模态视频」的全部实现（pi 没有 video 内容块，
 *      只能抽帧 + 给路径）。这里用一个假 `<video>` 驱动真实的 seek → canvas → 编码流程，
 *      验的是「按时间中点取帧、帧数随时长收敛、解不了就干净退出」。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyFile,
  encodeImageForModel,
  extractVideoFrames,
  isTextualFile,
} from "./attachment-file";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

describe("附件分类", () => {
  it("图片按 MIME 走，SVG 例外（它是文本）", () => {
    expect(classifyFile("a.png", "image/png")).toBe("image");
    expect(classifyFile("a.jpg", "image/jpeg")).toBe("image");
    // SVG 当文本读出来信息量更大（read_image 的描述也是这个口径）
    expect(classifyFile("icon.svg", "image/svg+xml")).toBe("text");
  });

  it("视频按 MIME 走", () => {
    expect(classifyFile("a.mp4", "video/mp4")).toBe("video");
    expect(classifyFile("a.webm", "video/webm")).toBe("video");
  });

  it("MIME 缺失时靠扩展名兜底（拖拽的 .log/.env 常常没有 type）", () => {
    expect(classifyFile("app.log", "")).toBe("text");
    expect(classifyFile("build.sh", "")).toBe("text");
    expect(classifyFile("data.json", "")).toBe("text");
    expect(classifyFile("Makefile", "")).toBe("text");
    expect(classifyFile("Dockerfile", "")).toBe("text");
    expect(classifyFile("clip.mp4", "")).toBe("video");
    expect(classifyFile("report.pdf", "")).toBe("file");
  });

  it("application/* 里的文本类也算文本", () => {
    expect(isTextualFile("a.json", "application/json")).toBe(true);
    expect(isTextualFile("a.yaml", "application/x-yaml")).toBe(true);
    expect(isTextualFile("a.bin", "application/octet-stream")).toBe(false);
  });
});

/** 假 `<video>`：按注册的监听器派发事件，模拟真实解码器的时序 */
function installFakeVideo(options: { duration: number; width: number; height: number }): {
  seeks: number[];
  restore: () => void;
} {
  const seeks: number[] = [];
  const listeners = new Map<string, Set<() => void>>();
  const video = {
    preload: "",
    muted: false,
    playsInline: false,
    crossOrigin: "",
    style: { cssText: "" },
    duration: options.duration,
    videoWidth: options.width,
    videoHeight: options.height,
    currentTime: 0,
    addEventListener: (type: string, handler: () => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(handler);
      listeners.set(type, set);
      // 真实解码器不会同步回调，这里推到下一个宏任务，让 await 的时序与线上一致
      setTimeout(() => {
        if (type === "seeked") seeks.push(video.currentTime);
        handler();
      }, 0);
    },
    removeEventListener: (type: string, handler: () => void) => {
      listeners.get(type)?.delete(handler);
    },
    removeAttribute: () => {},
    load: () => {},
    remove: () => {},
  };

  const originalCreate = document.createElement.bind(document);
  const createSpy = vi
    .spyOn(document, "createElement")
    .mockImplementation(((tag: string, opts?: ElementCreationOptions) =>
      tag === "video"
        ? (video as unknown as HTMLElement)
        : originalCreate(tag, opts)) as typeof document.createElement);
  const originalAppend = document.body.appendChild.bind(document.body);
  const appendSpy = vi
    .spyOn(document.body, "appendChild")
    .mockImplementation(((node: Node) =>
      node === (video as unknown as Node)
        ? node
        : originalAppend(node)) as typeof document.body.appendChild);

  // canvas：jsdom 没有 2D 上下文，垫一个最小可用的
  const contextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage: () => {} } as unknown as CanvasRenderingContext2D);
  const dataUrlSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "toDataURL")
    .mockReturnValue(`data:image/jpeg;base64,${PNG_B64}`);

  return {
    seeks,
    restore: () => {
      createSpy.mockRestore();
      appendSpy.mockRestore();
      contextSpy.mockRestore();
      dataUrlSpy.mockRestore();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("视频抽帧", () => {
  it("按时长决定帧数，抽帧点是每段的中点（不是端点）", async () => {
    const fake = installFakeVideo({ duration: 12, width: 1920, height: 1080 });
    try {
      const result = await extractVideoFrames(
        new File([new Uint8Array([1, 2, 3])], "clip.mp4", { type: "video/mp4" }),
      );
      // 12 秒 → ceil(12/3) = 4 帧
      expect(result?.frames).toHaveLength(4);
      // 中点：(i+0.5)/4*12 = 1.5, 4.5, 7.5, 10.5
      expect(result?.frameTimes).toEqual([1.5, 4.5, 7.5, 10.5]);
      expect(fake.seeks).toEqual([1.5, 4.5, 7.5, 10.5]);
      expect(result?.durationSeconds).toBe(12);
      // 画面尺寸保留原值（供信封说明），帧本身缩到长边以内
      expect(result?.width).toBe(1920);
      expect(result?.height).toBe(1080);
      expect(result?.frames[0]?.mimeType).toBe("image/jpeg");
    } finally {
      fake.restore();
    }
  });

  it("很短的视频至少抽 2 帧，很长的视频最多 8 帧", async () => {
    const short = installFakeVideo({ duration: 0.8, width: 640, height: 480 });
    try {
      expect(
        (await extractVideoFrames(new File([], "a.mp4", { type: "video/mp4" })))?.frames,
      ).toHaveLength(2);
    } finally {
      short.restore();
    }

    const long = installFakeVideo({ duration: 600, width: 640, height: 480 });
    try {
      expect(
        (await extractVideoFrames(new File([], "b.mp4", { type: "video/mp4" })))?.frames,
      ).toHaveLength(8);
    } finally {
      long.restore();
    }
  });

  it("解不出画面（尺寸为 0）时返回 null，不抛错", async () => {
    const fake = installFakeVideo({ duration: 5, width: 0, height: 0 });
    try {
      expect(
        await extractVideoFrames(new File([], "broken.mp4", { type: "video/mp4" })),
      ).toBeNull();
    } finally {
      fake.restore();
    }
  });
});

describe("图片编码", () => {
  it("长边超限时降采样，并给出缩放后的尺寸", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage: () => {},
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(
      `data:image/png;base64,${PNG_B64}`,
    );
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 4000,
      height: 3000,
      close: () => {},
    }));

    const encoded = await encodeImageForModel(
      new File([new Uint8Array([1])], "big.png", { type: "image/png" }),
    );
    expect(encoded?.reencoded).toBe(true);
    expect(encoded?.width).toBe(1568);
    expect(encoded?.height).toBe(1176);
    expect(encoded?.data).toBe(PNG_B64);
    vi.unstubAllGlobals();
  });

  it("解不出来时返回 null（调用方退回「按文件给路径」）", async () => {
    vi.stubGlobal("createImageBitmap", async () => {
      throw new Error("decode failed");
    });
    expect(
      await encodeImageForModel(new File([new Uint8Array([1])], "x.png", { type: "image/png" })),
    ).toBeNull();
    vi.unstubAllGlobals();
  });
});
