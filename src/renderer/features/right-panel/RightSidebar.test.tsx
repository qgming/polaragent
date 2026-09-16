// 右侧栏标签条的回归测试。
//
// **这个文件存在的理由**：多标签是这批改动里最容易被「看起来对」骗过去的部分 ——
// 标签条本身渲染出来了，但隐藏的浏览器标签一旦被卸载（或切换标签时整个内容区重挂载），
// <webview> 的 guest 就会被 Electron 销毁，主进程的自动化与页面状态一起丢。
// 所以这里钉住两件事：
//   1. **所有浏览器标签始终在 DOM 里**，只有当前标签可见（hidden 是 CSS 层的事）；
//   2. 主进程的 open-request 落到正确的标签上（复用 / 新建 / 幂等三条策略）。
//
// 标签内容（webview、登记 guest）由 BrowserPanel.test.tsx 覆盖，这里只关心
// 「哪个标签存在、哪个可见、事件怎么改状态」。
//
// 需要一个能在 jsdom 里当 webview 用的元素桩：面板挂载就会创建元素并调它的方法。

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RightSidebar } from "@/renderer/features/right-panel/RightSidebar";
import i18n from "@/renderer/i18n";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { BrowserEvent } from "@/shared/contracts/browser";

/** 与 BrowserPanel.test.tsx 同款的最小 webview 桩（jsdom 里没有真实 guest） */
function stubWebviewElement(): { webviews: HTMLElement[] } {
  const webviews: HTMLElement[] = [];
  const original = document.createElement.bind(document);

  vi.spyOn(document, "createElement").mockImplementation(
    (tagName: string, options?: ElementCreationOptions) => {
      const element = original(tagName, options);
      if (tagName !== "webview") return element;
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

  return { webviews };
}

/** 主进程两侧的桥（浏览器 + 窗口控制）的替身 */
function stubBridges(): { emit(event: BrowserEvent): void } {
  const listeners: ((event: BrowserEvent) => void)[] = [];

  vi.stubGlobal("oint", {
    browser: {
      status: () => Promise.resolve(null),
      registerTab: () => Promise.resolve(),
      unregisterTab: () => Promise.resolve(),
      activateTab: () => Promise.resolve(),
      onEvent: (callback: (event: BrowserEvent) => void) => {
        listeners.push(callback);
        return () => {
          const index = listeners.indexOf(callback);
          if (index !== -1) listeners.splice(index, 1);
        };
      },
    },
    window: {
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      // WindowControls 在挂载时订阅；必须返回取消订阅函数，否则卸载 TypeError
      onMaximizedChange: () => () => {},
    },
  });

  return {
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useUiStore.setState({
    rightPanelOpen: true,
    rightPanelTabs: [],
    activeTabId: null,
    pendingBrowserRequest: null,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("标签条", () => {
  it("每个标签渲染图标 + 名字 + ×；有页面标题时显示标题，否则显示视图名", () => {
    stubBridges();
    stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: "示例页面" },
        { id: "t2", view: "browser", title: null },
        { id: "t3", view: "files", title: null },
      ],
      activeTabId: "t1",
    });

    render(<RightSidebar />);

    const aside = screen.getByRole("complementary");
    expect(within(aside).getByText("示例页面")).toBeDefined();
    // 没报标题的浏览器标签显示视图名（不是空白，也不是同一个名字重复两次的产物之一）
    expect(within(aside).getByText("浏览器")).toBeDefined();
    expect(within(aside).getByText("文件")).toBeDefined();
    expect(within(aside).getAllByLabelText("关闭标签")).toHaveLength(3);
    expect(within(aside).getByLabelText("新建标签")).toBeDefined();
  });

  it("点标签只切换当前标签（不卸载别的）", () => {
    stubBridges();
    const { webviews } = stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: "第一页" },
        { id: "t2", view: "browser", title: "第二页" },
      ],
      activeTabId: "t2",
    });

    render(<RightSidebar />);
    screen.getByText("第一页").click();

    expect(useUiStore.getState().activeTabId).toBe("t1");
    // 两个 webview 都还在 DOM 里：切换不是卸载重建
    expect(webviews).toHaveLength(2);
  });

  it("× 关掉标签；最后一个也关掉后回到选择列表", async () => {
    stubBridges();
    stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [{ id: "t1", view: "browser", title: null }],
      activeTabId: "t1",
    });

    render(<RightSidebar />);
    screen.getByLabelText("关闭标签").click();

    expect(useUiStore.getState().rightPanelTabs).toHaveLength(0);
    expect(useUiStore.getState().activeTabId).toBeNull();
    // 选择列表（「+」那一屏）出现：等 React 的这次重渲染落地再断言
    expect(await screen.findByText("审查")).toBeDefined();
  });

  it("「+」回到选择列表，而不是直接再开一个浏览器标签", async () => {
    stubBridges();
    stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [{ id: "t1", view: "browser", title: null }],
      activeTabId: "t1",
    });

    render(<RightSidebar />);
    screen.getByLabelText("新建标签").click();

    expect(useUiStore.getState().activeTabId).toBeNull();
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(1);
    // 选择列表那一屏出现（「浏览器」这时在列表里与标签条上各出现一次，用只有列表才有的项断言）
    expect(await screen.findByText("审查")).toBeDefined();
    expect(screen.getByText("文件")).toBeDefined();
  });
});

describe("浏览器标签的常驻", () => {
  it("两个浏览器标签都挂载，非当前的那个只是 hidden", () => {
    stubBridges();
    const { webviews } = stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: "第一页" },
        { id: "t2", view: "browser", title: "第二页" },
      ],
      activeTabId: "t2",
    });

    render(<RightSidebar />);

    // 两个 guest 都活着：切回来时页面、滚动位置都还在（hidden 只是 CSS）
    expect(webviews).toHaveLength(2);
    expect(webviews[0]?.closest("div.hidden")).not.toBeNull();
    expect(webviews[1]?.closest("div.hidden")).toBeNull();
  });

  it("切到别的视图时浏览器标签也不卸载（模型仍能操作页面）", () => {
    stubBridges();
    const { webviews } = stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: null },
        { id: "t2", view: "files", title: null },
      ],
      activeTabId: "t2",
    });

    render(<RightSidebar />);

    expect(webviews).toHaveLength(1);
    expect(webviews[0]?.closest("div.hidden")).not.toBeNull();
  });
});

describe("模型的 open-request 落到哪个标签", () => {
  it("已有浏览器标签时复用（并把它切为当前、展开面板）", () => {
    const bridge = stubBridges();
    stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: "第一页" },
        { id: "t2", view: "browser", title: "第二页" },
      ],
      activeTabId: "t2",
      rightPanelOpen: false,
    });

    render(<RightSidebar />);
    bridge.emit({
      type: "open-request",
      requestId: "r1",
      newTab: false,
      tabId: "t1",
    } as BrowserEvent);

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(2);
    expect(state.activeTabId).toBe("t1");
    expect(state.rightPanelOpen).toBe(true);
    expect(state.pendingBrowserRequest).toBeNull();
  });

  it("没指定 tabId 的复用请求落在最后一个浏览器标签上（最近用的那个）", () => {
    const bridge = stubBridges();
    stubWebviewElement();
    useUiStore.setState({
      rightPanelTabs: [
        { id: "t1", view: "browser", title: "第一页" },
        { id: "t2", view: "browser", title: "第二页" },
      ],
      activeTabId: "t2",
    });

    render(<RightSidebar />);
    bridge.emit({ type: "open-request", requestId: "r1b", newTab: false } as BrowserEvent);

    expect(useUiStore.getState().activeTabId).toBe("t2");
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(2);
  });

  it("newTab 请求新建标签，并记下回执让 BrowserPanel 交回主进程", () => {
    const bridge = stubBridges();
    stubWebviewElement();
    useUiStore.setState({ rightPanelTabs: [], activeTabId: null, rightPanelOpen: false });

    render(<RightSidebar />);
    bridge.emit({ type: "open-request", requestId: "r2", newTab: true } as BrowserEvent);

    const state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("browser");
    expect(state.activeTabId).toBe(state.rightPanelTabs[0]?.id);
    expect(state.pendingBrowserRequest).toEqual({
      requestId: "r2",
      tabId: state.rightPanelTabs[0]?.id,
    });
  });

  it("同一个 requestId 重发（主进程重试）不会再建一个标签", () => {
    const bridge = stubBridges();
    stubWebviewElement();
    useUiStore.setState({ rightPanelTabs: [], activeTabId: null, rightPanelOpen: false });

    render(<RightSidebar />);
    bridge.emit({ type: "open-request", requestId: "r3", newTab: true } as BrowserEvent);
    bridge.emit({ type: "open-request", requestId: "r3", newTab: true } as BrowserEvent);
    bridge.emit({ type: "open-request", requestId: "r3", newTab: true } as BrowserEvent);

    expect(useUiStore.getState().rightPanelTabs).toHaveLength(1);
  });

  it("没有可用标签且不是 newTab 时也建一个（模型的第一次调用）", () => {
    const bridge = stubBridges();
    stubWebviewElement();
    useUiStore.setState({ rightPanelTabs: [], activeTabId: null, rightPanelOpen: false });

    render(<RightSidebar />);
    bridge.emit({
      type: "open-request",
      requestId: "r4",
      newTab: false,
      tabId: "t-does-not-exist",
    } as BrowserEvent);

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.pendingBrowserRequest?.requestId).toBe("r4");
  });
});
