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
//
// 多标签落地后这里又多了两个不变量：
//   1. **每个面板把自己的 tabId 与 guest 登记给主进程**（dom-ready 后 registerTab）——
//      主进程靠它按 tabId 找到 guest，模型的 open-request 也在这条回执上结算；
//   2. **模型操作提示只出现在事件指定的标签上**（agent 事件带 tabId 时）。
// 隐藏/常驻（display:none 而不是卸载）由 RightSidebar 负责，见 RightSidebar.test.tsx。

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPanel } from "@/renderer/features/right-panel/BrowserPanel";
import i18n from "@/renderer/i18n";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { BrowserEvent } from "@/shared/contracts/browser";

/**
 * 造一个能在 jsdom 里当 webview 用的元素。
 *
 * 不能只靠 document.createElement("webview")：jsdom 会给出一个 HTMLUnknownElement，
 * 而面板会调用 canGoBack/canGoForward 等方法 —— 缺了它们，测试失败的原因是
 * 「stub 不全」而不是「被测代码错了」，那种噪声会让人不再相信这个文件。
 *
 * 返回 webviews 数组（按创建顺序）与 ready()：面板是命令式创建元素的，
 * 测试得拿到元素本身才能触发 dom-ready（guest 登记发生在那一刻）。
 */
function stubWebviewElement(): {
  webviews: HTMLElement[];
  ready(index: number): void;
} {
  const webviews: HTMLElement[] = [];
  const original = document.createElement.bind(document);

  vi.spyOn(document, "createElement").mockImplementation(
    (tagName: string, options?: ElementCreationOptions) => {
      const element = original(tagName, options);
      if (tagName !== "webview") return element;
      // 每个元素给一个不同的 WebContents id：断言「登记的是这个标签的 guest」时才有区分度
      const webContentsId = webviews.length + 1;
      Object.assign(element, {
        canGoBack: () => false,
        canGoForward: () => false,
        goBack: () => undefined,
        goForward: () => undefined,
        reload: () => undefined,
        stop: () => undefined,
        loadURL: () => Promise.resolve(),
        getWebContentsId: () => webContentsId,
      });
      webviews.push(element);
      return element;
    },
  );

  return {
    webviews,
    ready: (index) => {
      const element = webviews[index];
      if (element === undefined) throw new Error(`没有第 ${index} 个 webview 元素`);
      // Electron 在 guest 可用后发出 dom-ready：面板在那一刻读 getWebContentsId 并登记
      element.dispatchEvent(new Event("dom-ready"));
    },
  };
}

/** 主进程浏览器桥的替身：记录登记 / 注销 / 激活调用，并能向面板推送事件 */
function stubBrowserBridge(): {
  registerTab: ReturnType<typeof vi.fn>;
  unregisterTab: ReturnType<typeof vi.fn>;
  activateTab: ReturnType<typeof vi.fn>;
  emit(event: BrowserEvent): void;
} {
  const registerTab = vi.fn(() => Promise.resolve());
  const unregisterTab = vi.fn(() => Promise.resolve());
  const activateTab = vi.fn(() => Promise.resolve());
  const listeners: ((event: BrowserEvent) => void)[] = [];

  vi.stubGlobal("oint", {
    app: { openPath: () => Promise.resolve({ ok: true }) },
    browser: {
      status: () => Promise.resolve(null),
      registerTab,
      unregisterTab,
      activateTab,
      onEvent: (callback: (event: BrowserEvent) => void) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
    },
  });

  return {
    registerTab,
    unregisterTab,
    activateTab,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  useUiStore.setState({
    rightPanelTabs: [],
    activeTabId: null,
    pendingBrowserRequest: null,
    browserOpenRequest: null,
  });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useUiStore.setState({
    rightPanelTabs: [],
    activeTabId: null,
    pendingBrowserRequest: null,
    browserOpenRequest: null,
  });
});

describe("BrowserPanel 的 webview 引导", () => {
  it("把元素插进 DOM 时**必须同时给它一个 src** —— 否则 Electron 永远不会创建 guest", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    render(<BrowserPanel tabId="t1" active />);

    const webview = webviews[0] ?? document.querySelector("webview");
    expect(webview, "面板没有创建 webview 元素").not.toBeNull();

    // 这是本次修复的核心不变量。Electron 44 的 <webview> 只在第一次设置 src 时才
    // 创建 guest；不给 src 就没有 did-attach-webview，主进程的自动化一路等到超时。
    const src = webview?.getAttribute("src");
    expect(src, "webview 元素没有 src：guest 不会被创建，8 个浏览器工具会全部超时").not.toBeNull();
    expect(src).not.toBe("");
  });

  it("用 about:blank 引导，而不是让地址栏先有内容（空态提示要照常显示）", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    render(<BrowserPanel tabId="t1" active />);

    expect(webviews[0]?.getAttribute("src")).toBe("about:blank");

    // 引导不等于「打开了页面」：空态提示必须还在。
    // 若哪天有人在 onNavigate 里放行了 about:blank，hasPage 会变成 true、提示消失、
    // 刷新按钮变亮、地址栏显示 about:blank —— 这条断言就是为那个情形准备的。
    expect(screen.getByText("还没有打开页面")).toBeDefined();
  });

  it("引导之后地址栏仍然是空的（不给用户看 about:blank）", () => {
    stubBrowserBridge();
    stubWebviewElement();
    render(<BrowserPanel tabId="t1" active />);

    const address = screen.getByLabelText("输入网址，回车打开") as HTMLInputElement;
    expect(address.value).toBe("");
  });
});

/**
 * 点 HTML 文件卡片 → 用内置浏览器打开那个本地地址。
 *
 * **这一组是为一个只在 dev 下出现的缺陷写的**（实测，见 BrowserPanel 里那段说明）：
 * 第一版把「打开这个地址」当成一次性事件，BrowserPanel 读到就结算。StrictMode 下组件
 * 挂载两次，第一次的元素随后被清理 effect 摘掉、请求却已经结算，于是**留在 DOM 里的**
 * 那个 webview 永远停在 about:blank —— 浏览器打开了、标签也在，页面是白的。
 *
 * 这里用 `<StrictMode>` 渲染来复现那个双挂载，断言的是「最后留在 DOM 里的元素拿到了地址」。
 * 注意不能断言「某个元素拿到过」：第一次挂载那个也确实拿到过，只是马上被摘掉了。
 */
describe("用浏览器打开本地文件（HTML 卡片）", () => {
  /**
   * **核心回归**：请求不能是「谁先读到谁清掉」的一次性事件。
   *
   * 这个用例的写法是被逼出来的，值得说明为什么不能写成「挂载两次」：
   * jsdom 里 `render(<StrictMode>…)` 的两次 effect 调用发生在**同一个 act 批次**内，
   * 中间那次 `setState` 还没被 React 处理，于是旧的一次性实现也能「碰巧」通过 ——
   * 我实测确认过这一点（把旧实现放回去，那个写法依然全绿）。
   *
   * 所以改成**显式地先卸载再挂载**：卸载是一次 act 边界，store 的写入在那之前就已经
   * 落地了。这时旧实现必然失败（请求被上一个面板消费掉了，新面板拿到 null），
   * 新实现通过（请求留在 store 里，由 (元素, token) 判重）。
   *
   * 它对应两条真实路径：StrictMode 的双挂载，以及**关掉浏览器标签再打开**。
   */
  it("后挂载的面板也能领到请求（请求不是一次性的）", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();

    useUiStore.setState({
      rightPanelOpen: true,
      rightPanelTabs: [{ id: "t1", view: "browser", title: "page.html" }],
      activeTabId: "t1",
      browserOpenRequest: { url: "file:///D:/p/page.html", title: "page.html", token: 1 },
    });

    const first = render(<BrowserPanel tabId="t1" active />);
    // 第一个元素确实拿到了地址（这一步两种实现都对）
    expect(webviews[0]?.getAttribute("src")).toBe("file:///D:/p/page.html");

    // 卸载再挂载（= 关掉标签再打开，也是 StrictMode 双挂载的实质）
    first.unmount();
    render(<BrowserPanel tabId="t1" active />);

    const live = webviews.filter((element) => element.isConnected);
    expect(live.length, "重新挂载后应当只有一个 webview 留在文档里").toBe(1);
    expect(
      live[0]?.getAttribute("src"),
      "新面板拿到的地址是 about:blank：说明请求被上一个面板消费掉了（旧的「读一次就清掉」实现）",
    ).toBe("file:///D:/p/page.html");
  });

  it("同一个 token 不重复导航（重渲染不会让页面自己刷新）", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    const { rerender } = render(<BrowserPanel tabId="t1" active />);

    act(() => {
      useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    });
    const element = webviews[0];
    // 用户此时在页面里点了个链接（直接改属性，模拟页面自己导航走了）
    element?.setAttribute("src", "file:///D:/p/other.html");

    // 一次无关的重渲染：请求没变，不该把地址写回去
    rerender(<BrowserPanel tabId="t1" active />);

    expect(element?.getAttribute("src")).toBe("file:///D:/p/other.html");
  });

  it("再点一次同一个文件（新 token）会重新加载", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    render(<BrowserPanel tabId="t1" active />);

    act(() => {
      useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    });
    const element = webviews[0];
    element?.setAttribute("src", "file:///D:/p/other.html");

    act(() => {
      useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    });

    // token 变了 → 重新导航（这就是「再点一次 = 刷新」）
    expect(element?.getAttribute("src")).toBe("file:///D:/p/a.html");
  });

  it("非活动标签不响应：同一份文件不会被加载两次", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    render(<BrowserPanel tabId="t1" active={false} />);

    act(() => {
      useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    });

    expect(webviews[0]?.getAttribute("src")).toBe("about:blank");
  });
});

describe("BrowserPanel 与主进程的标签登记", () => {
  it("dom-ready 之后用 tabId + webContentsId 登记 guest", () => {
    const bridge = stubBrowserBridge();
    const { ready } = stubWebviewElement();

    render(<BrowserPanel tabId="t1" active />);
    // dom-ready 之前不登记：那一刻 getWebContentsId 还不可用（面板读了会抛）
    expect(bridge.registerTab).not.toHaveBeenCalled();

    ready(0);
    expect(bridge.registerTab).toHaveBeenCalledWith("t1", 1, undefined);
  });

  it("为 open-request 建的标签把回执一起交回，并结算掉待处理的请求", () => {
    const bridge = stubBrowserBridge();
    const { ready } = stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [{ id: "t1", view: "browser", title: null }],
      activeTabId: "t1",
      pendingBrowserRequest: { requestId: "r7", tabId: "t1" },
    });

    render(<BrowserPanel tabId="t1" active />);
    ready(0);

    expect(bridge.registerTab).toHaveBeenCalledWith("t1", 1, "r7");
    expect(useUiStore.getState().pendingBrowserRequest).toBeNull();
  });

  it("多个标签各自登记自己的 tabId 与 guest（不会串号）", () => {
    const bridge = stubBrowserBridge();
    const { ready } = stubWebviewElement();

    render(
      <>
        <BrowserPanel tabId="t1" active={false} />
        <BrowserPanel tabId="t2" active />
      </>,
    );
    ready(0);
    ready(1);

    expect(bridge.registerTab).toHaveBeenCalledWith("t1", 1, undefined);
    expect(bridge.registerTab).toHaveBeenCalledWith("t2", 2, undefined);
  });

  it("卸载标签时注销 guest（fire-and-forget，主进程据此释放引用）", () => {
    const bridge = stubBrowserBridge();
    stubWebviewElement();

    const { unmount } = render(<BrowserPanel tabId="t1" active />);
    unmount();

    expect(bridge.unregisterTab).toHaveBeenCalledWith("t1");
  });

  it("成为当前标签时通知主进程激活（status 里的 active 由它维护）", () => {
    const bridge = stubBrowserBridge();
    stubWebviewElement();

    const { rerender } = render(<BrowserPanel tabId="t1" active={false} />);
    expect(bridge.activateTab).not.toHaveBeenCalled();

    rerender(<BrowserPanel tabId="t1" active />);
    expect(bridge.activateTab).toHaveBeenCalledWith("t1");
  });
});

describe("BrowserPanel 的页面标题与模型提示", () => {
  it("页面报出标题后标签名换成标题（页面没写标题时退回 URL）", () => {
    stubBrowserBridge();
    const { webviews } = stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [{ id: "t1", view: "browser", title: null }],
      activeTabId: "t1",
    });

    render(<BrowserPanel tabId="t1" active />);

    const element = webviews[0];
    // webview 的事件把字段挂在事件对象上（不是 detail），与 did-navigate 的 url 同一形态
    const titled = new Event("page-title-updated");
    Object.assign(titled, { title: "示例页面" });
    element?.dispatchEvent(titled);

    expect(useUiStore.getState().rightPanelTabs[0]?.title).toBe("示例页面");
  });

  it("模型操作提示只出现在事件指定的标签上；不带 tabId 的按「对所有标签成立」处理", async () => {
    const bridge = stubBrowserBridge();
    stubWebviewElement();
    render(<BrowserPanel tabId="t1" active />);

    bridge.emit({ type: "agent", active: true, note: "", tabId: "t2" } as BrowserEvent);
    expect(screen.queryByText("Oint 正在操作这个页面…")).toBeNull();

    bridge.emit({ type: "agent", active: true, note: "" } as BrowserEvent);
    expect(await screen.findByText("Oint 正在操作这个页面…")).toBeDefined();

    bridge.emit({ type: "agent", active: false, note: "" } as BrowserEvent);
    await waitFor(() => expect(screen.queryByText("Oint 正在操作这个页面…")).toBeNull());
  });
});
