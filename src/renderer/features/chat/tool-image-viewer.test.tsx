/**
 * 会话里的图片：**详情里显示缩略图，点它打开大图查看器**。
 *
 * 用户的原话是「查看详情时要显示真实的图片 …… 点击这个小图触发图片查看模态窗」，
 * 而这条链上有三处各自都可能悄悄断掉：
 *   1. 图片本体到不了渲染层（主进程只把它放进 content，而 content 的 image 块在
 *      toolResultValue 里被文本盖住 —— 见 main/pisdk/tool-images.ts）；
 *   2. 到了渲染层却没有渲染方（截图详情原来只显示 viewport 那几行读数）；
 *   3. 渲染了却点不开（缩略图不是 button、或查看器没接上）。
 * 这里从**渲染结果**上断言，覆盖第 2、3 处；第 1 处由主进程侧的 tool-images.test.ts 覆盖。
 */
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ImagePreview } from "@/renderer/components/ui/image-viewer";
import i18n from "@/renderer/i18n";
import { ToolCallPart } from "./ToolParts";

/** 一张 1×1 的透明 PNG：形状是 dataUrl 就行，内容不影响断言 */
const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

afterEach(() => {
  cleanup();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** 渲染一张缩略图 + 查看器（会话里两处图片详情共用的那一对） */
function renderPreview() {
  return render(<ImagePreview src={DATA_URL} alt="页面截图" title="页面截图" />);
}

/** 直接渲染一次截图工具调用；providerMetadata 就是 message-converter 放进 aui 的那个槽位 */
function renderScreenshotPart() {
  const props = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "browser_screenshot",
    args: {},
    argsText: "{}",
    artifact: { width: 380, height: 639, tabId: "t1" },
    result: "Screenshot of the visible viewport (380×639).",
    providerMetadata: { oint: { images: [{ mimeType: "image/png", dataUrl: DATA_URL }] } },
    status: { type: "complete" },
    addResult: () => {},
    resume: () => {},
    respondToApproval: async () => {},
  } as unknown as ToolCallMessagePartProps;

  return render(<ToolCallPart {...props} />);
}

describe("图片缩略图与查看器", () => {
  it("缩略图是**可点的按钮**（键盘与辅助技术都能触发），点开弹出大图", () => {
    renderPreview();

    // 不是 <img onClick>：无障碍名称必须能查到，键盘用户才有把手
    const thumb = screen.getByRole("button", { name: "查看大图" });
    expect(thumb.querySelector("img")?.getAttribute("src")).toBe(DATA_URL);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(thumb);

    const dialog = screen.getByRole("dialog");
    const opened = dialog.querySelector("img");
    expect(opened?.getAttribute("src")).toBe(DATA_URL);
    // 大图是**同一张图的原图**，不是缩略图的放大副本（没有额外缩放/裁剪）
    expect(dialog.textContent).not.toContain("data:image");
  });

  it("按 Esc 关闭查看器：看得清之后要能一键回到对话", () => {
    renderPreview();
    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("截图工具的详情", () => {
  it("展开后显示真实图片，而不是只有 viewport 读数", () => {
    renderScreenshotPart();

    // 折叠行：展开前详情不渲染
    expect(screen.queryByRole("button", { name: "查看大图" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /截取页面/ }));

    const thumb = screen.getByRole("button", { name: "查看大图" });
    expect(thumb.querySelector("img")?.getAttribute("src")).toBe(DATA_URL);
    // 读数也在：图说「看起来是什么样」，读数说「多大、哪个标签」
    expect(screen.getByText("380×639")).toBeTruthy();
  });

  it("点缩略图打开大图模态窗（与设置模态同族的 Dialog）", () => {
    renderScreenshotPart();
    fireEvent.click(screen.getByRole("button", { name: /截取页面/ }));
    fireEvent.click(screen.getByRole("button", { name: "查看大图" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe(DATA_URL);
  });

  it("没有图片的截图（历史里那些旧条目）照样显示读数，不摆一个空图框", () => {
    const props = {
      type: "tool-call",
      toolCallId: "call-2",
      toolName: "browser_screenshot",
      args: {},
      argsText: "{}",
      artifact: { width: 380, height: 639, tabId: "t1" },
      result: "Screenshot of the visible viewport (380×639).",
      status: { type: "complete" },
      addResult: () => {},
      resume: () => {},
      respondToApproval: async () => {},
    } as unknown as ToolCallMessagePartProps;

    render(<ToolCallPart {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /截取页面/ }));

    expect(screen.queryByRole("button", { name: "查看大图" })).toBeNull();
    expect(screen.getByText("380×639")).toBeTruthy();
  });
});
