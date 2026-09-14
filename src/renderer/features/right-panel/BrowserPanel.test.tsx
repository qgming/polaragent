// 内置浏览器面板的回归测试。
//
// **这个文件存在的理由**：本次修的是一个「谁都测不到」的缺陷 —— 渲染层建出 <webview>
// 元素、而 Electron 只在元素**第一次设置 src** 时才创建 guest。两边的单测都覆盖不到
// 这条缝：主进程那一侧注入的是假 BrowserAutomation，渲染层这一侧此前没有任何测试。
// 症状是 8 个浏览器工具全部超时，而 19 个单测全绿。
//
// 所以这里断言的就是那个不变量：**元素插入 DOM 时必须带上一个 src**。
// jsdom 里没有真正的 guest，测不了「是否 attach」；但「有没有设 src」是它的必要前提，
// 而「忘了设」正是那次踩坑的形态。配套的 Electron 集成复现见 docs 的浏览器操作一节。

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "@/renderer/features/right-panel/BrowserPanel";
import i18n from "@/renderer/i18n";

/**
 * 造一个能在 jsdom 里当 webview 用的元素。
 *
 * 不能只靠 document.createElement("webview")：jsdom 会给出一个 HTMLUnknownElement，
 * 而面板会调用 canGoBack/canGoForward 等方法 —— 缺了它们，测试失败的原因是
 * 「stub 不全」而不是「被测代码错了」，那种噪声会让人不再相信这个文件。
 */
function stubWebviewElement(host: HTMLElement): { element: HTMLElement; created: () => boolean } {
  let created = false;
  const original = document.createElement.bind(document);

  vi.spyOn(document, "createElement").mockImplementation(
    (tagName: string, options?: ElementCreationOptions) => {
      const element = original(tagName, options);
      if (tagName !== "webview") return element;
      created = true;
      // 面板用到的 webview 专有成员：给最小实现，返回可预测的值
      Object.assign(element, {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
        reload: () => undefined,
        stop: () => undefined,
        loadURL: () => Promise.resolve(),
      });
      return element;
    },
  );

  return {
    element: host,
    created: () => created,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  vi.stubGlobal("oint", {
    app: { openPath: () => Promise.resolve({ ok: true }) },
    browser: {
      status: () => Promise.resolve(null),
      // 面板挂载时会订阅；必须返回取消订阅函数，否则卸载 TypeError
      onEvent: () => () => {},
    },
  });
});

describe("BrowserPanel 的 webview 引导", () => {
  it("把元素插进 DOM 时**必须同时给它一个 src** —— 否则 Electron 永远不会创建 guest", () => {
    const { element: host } = stubWebviewElement(document.body);
    render(<BrowserPanel />);

    const webview = host.querySelector("webview") ?? document.querySelector("webview");
    expect(webview, "面板没有创建 webview 元素").not.toBeNull();

    // 这是本次修复的核心不变量。Electron 44 的 <webview> 只在第一次设置 src 时才
    // 创建 guest；不给 src 就没有 did-attach-webview，主进程的自动化一路等到超时。
    const src = webview?.getAttribute("src");
    expect(src, "webview 元素没有 src：guest 不会被创建，8 个浏览器工具会全部超时").not.toBeNull();
    expect(src).not.toBe("");
  });

  it("用 about:blank 引导，而不是让地址栏先有内容（空态提示要照常显示）", () => {
    const { element: host } = stubWebviewElement(document.body);
    render(<BrowserPanel />);

    const webview = host.querySelector("webview");
    expect(webview?.getAttribute("src")).toBe("about:blank");

    // 引导不等于「打开了页面」：空态提示必须还在。
    // 若哪天有人在 onNavigate 里放行了 about:blank，hasPage 会变成 true、提示消失、
    // 刷新按钮变亮、地址栏显示 about:blank —— 这条断言就是为那个情形准备的。
    expect(screen.getByText("还没有打开页面")).toBeDefined();
  });

  it("引导之后地址栏仍然是空的（不给用户看 about:blank）", () => {
    stubWebviewElement(document.body);
    render(<BrowserPanel />);

    const address = screen.getByLabelText("输入网址，回车打开") as HTMLInputElement;
    expect(address.value).toBe("");
  });
});
