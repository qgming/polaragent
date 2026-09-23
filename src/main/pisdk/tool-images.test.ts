// 工具结果里的图片 → 界面图片的收口（见 tool-images.ts 的文件头）。
//
// 这里钉的是**哪一类工具该带图**，因为它是内存与会话库的分界线：
//   · browser_screenshot 必须带（它的图没有可回读的路径）；
//   · read_image 刻意不带（它给 path，界面按需现取）。
// 两边任意一侧写错都不会报错，只会让「刷新之后图没了」或「会话内存里堆着几 MB base64」
// 这类问题在很久之后才浮现 —— 所以判断必须钉在测试里。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { toolPartImages } from "./tool-images";

/** 一张 1×1 的透明 PNG（base64 内容不影响判断，形状才是被测对象） */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function imageBlock(mimeType = "image/png", data = PNG_BASE64) {
  return { type: "image", mimeType, data };
}

describe("工具图片的收口", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("截图：结果里的 image 块 → dataUrl（渲染层唯一能直接塞进 <img src> 的形态）", () => {
    const images = toolPartImages("browser_screenshot", [
      { type: "text", text: "Screenshot of the visible viewport" },
      imageBlock(),
    ]);

    expect(images).toHaveLength(1);
    expect(images?.[0]?.mimeType).toBe("image/png");
    expect(images?.[0]?.dataUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);
  });

  it("read_image 不带图：它给 path，界面用 files.readImage 现取（这条是刻意的）", () => {
    expect(toolPartImages("read_image", [imageBlock()])).toBeUndefined();
  });

  it("没有 image 块的截图（纯文本结果）不带图，而不是带一个空数组", () => {
    expect(toolPartImages("browser_screenshot", [{ type: "text", text: "…" }])).toBeUndefined();
    expect(toolPartImages("browser_screenshot", [])).toBeUndefined();
    expect(toolPartImages("browser_screenshot", undefined)).toBeUndefined();
  });

  it("缺 data / mimeType 的坏块直接丢掉：编一个类型只会让 <img> 静默失败", () => {
    expect(
      toolPartImages("browser_screenshot", [
        { type: "image", mimeType: "image/png" },
        { type: "image", data: PNG_BASE64 },
      ]),
    ).toBeUndefined();
  });

  it("超过上限时放弃整张图（并留下一条告警），不把一条消息撑到几十 MB", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // 上限是 12MB 的 base64；这里给一个刚好超出的块，不去真的分配 12MB 字符串
    const huge = "A".repeat(12 * 1024 * 1024 + 1);

    expect(toolPartImages("browser_screenshot", [imageBlock("image/png", huge)])).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
  });
});
