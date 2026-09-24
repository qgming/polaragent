import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./ui-store";

/**
 * 每个用例都从「面板收起、一个标签都没有」出发。
 *
 * 标签 id 的计数器是模块级的（不随状态清空），所以断言只比较关系
 *（数量、谁等于谁、谁不等于谁），绝不写死 "t1" 这类具体值 ——
 * 写死会让用例的执行顺序决定成败。
 */
function resetPanel(): void {
  useUiStore.setState({
    rightPanelOpen: false,
    rightPanelTabs: [],
    activeTabId: null,
    pendingBrowserRequest: null,
    subagentPanelTarget: null,
    filePanelTarget: null,
    browserOpenRequest: null,
  });
}

describe("搜索跳转", () => {
  beforeEach(() => {
    useUiStore.setState({ searchJump: null });
  });

  it("记录目标会话与消息", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    expect(useUiStore.getState().searchJump).toMatchObject({ sessionId: "s1", messageId: "m1" });
  });

  it("重复跳同一条也换新的 token：Thread 靠它重新定位", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    const first = useUiStore.getState().searchJump?.token;
    useUiStore.getState().jumpToMessage("s1", "m1");
    const second = useUiStore.getState().searchJump?.token;
    expect(second).not.toBe(first);
  });

  it("清空后再次跳同一目标，token 仍不与上次重复 —— 否则会撞上已消费的记录而不再滚动", () => {
    useUiStore.getState().jumpToMessage("s1", "m1");
    const first = useUiStore.getState().searchJump?.token;
    useUiStore.getState().clearSearchJump();
    expect(useUiStore.getState().searchJump).toBeNull();
    useUiStore.getState().jumpToMessage("s1", "m1");
    expect(useUiStore.getState().searchJump?.token).not.toBe(first);
  });

  it("token 单调递增", () => {
    const tokens: number[] = [];
    for (const id of ["a", "b", "c"]) {
      useUiStore.getState().jumpToMessage("s1", id);
      const token = useUiStore.getState().searchJump?.token;
      if (token !== undefined) tokens.push(token);
    }
    expect(tokens).toEqual([...tokens].sort((x, y) => x - y));
    expect(new Set(tokens).size).toBe(tokens.length);
  });
});

describe("右侧面板的标签", () => {
  beforeEach(resetPanel);

  it("openRightPanel：展开面板并聚焦到该视图的标签", () => {
    useUiStore.getState().openRightPanel("files");

    const state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("files");
    expect(state.activeTabId).toBe(state.rightPanelTabs[0]?.id);
  });

  it("同一个单例视图打开两次只留一个标签，第二次只是切回去", () => {
    useUiStore.getState().openRightPanel("files");
    const first = useUiStore.getState().activeTabId;

    // 先切走，制造「已经有标签但不在当前」的情形
    useUiStore.getState().openRightPanel("review");
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(2);

    useUiStore.getState().openRightPanel("files");
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(2);
    expect(useUiStore.getState().activeTabId).toBe(first);
  });

  it("openBrowserTab 每次都新建一个浏览器标签并激活它", () => {
    const first = useUiStore.getState().openBrowserTab();
    const second = useUiStore.getState().openBrowserTab();

    const state = useUiStore.getState();
    expect(first).not.toBe(second);
    expect(state.rightPanelTabs.map((tab) => tab.id)).toEqual([first, second]);
    expect(state.rightPanelTabs.every((tab) => tab.view === "browser")).toBe(true);
    expect(state.activeTabId).toBe(second);
    expect(state.rightPanelOpen).toBe(true);
  });

  it('openRightPanel("browser") 每次都新开标签；其余视图复用', () => {
    useUiStore.getState().openBrowserTab();
    const second = useUiStore.getState().openBrowserTab();

    // 浏览器是多实例视图：从选择列表点它 / Ctrl+T 都是「新建标签页」的语义，
    // 复用已有标签会让「怎么开第二个」变成一道无解的题
    useUiStore.getState().openRightPanel("browser");
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(3);
    expect(useUiStore.getState().activeTabId).not.toBe(second);

    // 终端是单例视图：再点一次只是切回去，不会多出一个标签
    useUiStore.getState().openRightPanel("terminal");
    const terminalCount = useUiStore.getState().rightPanelTabs.length;
    useUiStore.getState().openRightPanel("terminal");
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(terminalCount);
  });

  it("关掉当前标签后接上右邻", () => {
    useUiStore.getState().openRightPanel("files");
    const first = useUiStore.getState().activeTabId;
    useUiStore.getState().openRightPanel("review");
    const middle = useUiStore.getState().activeTabId;
    useUiStore.getState().openRightPanel("terminal");
    const last = useUiStore.getState().activeTabId;

    // 回到中间那个再关掉它：接上的应该是右邻（terminal）
    useUiStore.getState().activateRightPanelTab(middle ?? "");
    useUiStore.getState().closeRightPanelTab(middle ?? "");

    const state = useUiStore.getState();
    expect(state.rightPanelTabs.map((tab) => tab.id)).toEqual([first, last]);
    expect(state.activeTabId).toBe(last);
  });

  it("关掉最右边的标签时接上左邻", () => {
    useUiStore.getState().openRightPanel("files");
    const first = useUiStore.getState().activeTabId;
    useUiStore.getState().openRightPanel("review");
    const second = useUiStore.getState().activeTabId;

    useUiStore.getState().closeRightPanelTab(second ?? "");
    expect(useUiStore.getState().activeTabId).toBe(first);
  });

  it("关掉的不是当前标签时不动焦点", () => {
    useUiStore.getState().openRightPanel("files");
    useUiStore.getState().openRightPanel("review");
    const active = useUiStore.getState().activeTabId;
    const inactive = useUiStore.getState().rightPanelTabs[0]?.id;

    useUiStore.getState().closeRightPanelTab(inactive ?? "");
    expect(useUiStore.getState().activeTabId).toBe(active);
    expect(useUiStore.getState().rightPanelTabs).toHaveLength(1);
  });

  it("关掉最后一个标签回到选择列表那一屏（面板不收起）", () => {
    useUiStore.getState().openRightPanel("files");
    const only = useUiStore.getState().activeTabId;

    useUiStore.getState().closeRightPanelTab(only ?? "");

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
    expect(state.rightPanelOpen).toBe(true);
  });

  it("showRightPanelChooser 只清焦点，标签都还留着", () => {
    useUiStore.getState().openRightPanel("files");
    useUiStore.getState().showRightPanelChooser();

    const state = useUiStore.getState();
    expect(state.activeTabId).toBeNull();
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelOpen).toBe(true);
  });

  it("setRightPanelTabTitle 换成页面标题；空串还原为视图名", () => {
    const id = useUiStore.getState().openBrowserTab();

    useUiStore.getState().setRightPanelTabTitle(id, "  示例页面  ");
    expect(useUiStore.getState().rightPanelTabs[0]?.title).toBe("示例页面");

    useUiStore.getState().setRightPanelTabTitle(id, "");
    expect(useUiStore.getState().rightPanelTabs[0]?.title).toBeNull();
  });

  it("setRightPanelTabTitle 对已关掉的标签不做任何事（标题事件可能晚到）", () => {
    const tabs = useUiStore.getState().rightPanelTabs;
    useUiStore.getState().setRightPanelTabTitle("t-does-not-exist", "x");
    expect(useUiStore.getState().rightPanelTabs).toBe(tabs);
  });

  it("回执跟着标签走：关掉还没结算的那个标签时丢弃它", () => {
    const id = useUiStore.getState().openBrowserTab();
    useUiStore.setState({ pendingBrowserRequest: { requestId: "r1", tabId: id } });

    useUiStore.getState().closeRightPanelTab(id);
    expect(useUiStore.getState().pendingBrowserRequest).toBeNull();

    // 关别的标签不受影响
    const keep = useUiStore.getState().openBrowserTab();
    const other = useUiStore.getState().openBrowserTab();
    useUiStore.setState({ pendingBrowserRequest: { requestId: "r2", tabId: keep } });
    useUiStore.getState().closeRightPanelTab(other);
    expect(useUiStore.getState().pendingBrowserRequest).toEqual({
      requestId: "r2",
      tabId: keep,
    });
  });

  it("settleBrowserRequest 清掉待结算的回执", () => {
    const id = useUiStore.getState().openBrowserTab();
    useUiStore.setState({ pendingBrowserRequest: { requestId: "r1", tabId: id } });
    useUiStore.getState().settleBrowserRequest();
    expect(useUiStore.getState().pendingBrowserRequest).toBeNull();
  });

  it("openSubagentPanel 保证有子智能体标签并聚焦到该次运行；再点别的运行复用同一个标签", () => {
    useUiStore.getState().openSubagentPanel("d1");

    let state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("subagent");
    expect(state.subagentPanelTarget).toBe("d1");

    useUiStore.getState().openSubagentPanel("d2");
    state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.subagentPanelTarget).toBe("d2");

    // 「返回列表」只清焦点，标签还在（独立动作，见 ui-store 的说明）
    useUiStore.getState().clearSubagentPanelTarget();
    state = useUiStore.getState();
    expect(state.subagentPanelTarget).toBeNull();
    expect(state.rightPanelTabs).toHaveLength(1);
  });

  it("activateRightPanelTab 只认存在的标签", () => {
    useUiStore.getState().openRightPanel("files");
    const id = useUiStore.getState().activeTabId;
    useUiStore.getState().activateRightPanelTab("t-does-not-exist");
    expect(useUiStore.getState().activeTabId).toBe(id);
  });
});

/**
 * 文件查看器与「用浏览器打开一个文件」这两个动作。
 *
 * 它们与 openRightPanel 的关键差别是**复用规则**：openRightPanel("browser") 每次都是
 * 新标签（多开是特性），而从文件卡片点出去是「看这一个文件」—— 点三次不该开出三个标签。
 * 这一条没有类型信号，只能靠断言钉住。
 */
describe("文件查看器（openFilePanel）", () => {
  beforeEach(resetPanel);

  it("首次打开建一个 file 标签并聚焦到该文件", () => {
    useUiStore.getState().openFilePanel("D:/p/a.md");

    const state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("file");
    expect(state.filePanelTarget).toBe("D:/p/a.md");
  });

  it("再点别的文件复用同一个标签（不是每文件一个标签）", () => {
    useUiStore.getState().openFilePanel("D:/p/a.md");
    const firstTabId = useUiStore.getState().activeTabId;
    useUiStore.getState().openFilePanel("D:/p/b.md");

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.activeTabId).toBe(firstTabId);
    expect(state.filePanelTarget).toBe("D:/p/b.md");
  });

  it("已经有别的视图标签时另开一个 file 标签，不动原来那个", () => {
    useUiStore.getState().openRightPanel("review");
    useUiStore.getState().openFilePanel("D:/p/a.md");

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(2);
    expect(state.rightPanelTabs.map((tab) => tab.view)).toEqual(["review", "file"]);
  });

  // 「file 不在面板选择列表里」这条已搬到 features/right-panel/panels.test.tsx ——
  // 那件事现在由注册表的 `chooseable` 标志表达，不再是 store 里的顺序表。
});

describe("用内置浏览器打开地址（openInBrowser）", () => {
  beforeEach(resetPanel);

  it("没有浏览器标签时新建一个，并把标签名先按文件名写上", () => {
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/page.html", title: "page.html" });

    const state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("browser");
    expect(state.rightPanelTabs[0]?.title).toBe("page.html");
    expect(state.browserOpenRequest?.url).toBe("file:///D:/p/page.html");
  });

  it("已有浏览器标签时复用它而不是再开一个（与「+」的新建语义相反）", () => {
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    const tabId = useUiStore.getState().activeTabId;
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/b.html", title: "b.html" });

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.activeTabId).toBe(tabId);
    expect(state.browserOpenRequest?.url).toBe("file:///D:/p/b.html");
  });

  it("连续两次请求的 token 递增：同一个地址点两次也要能再次触发导航", () => {
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    const first = useUiStore.getState().browserOpenRequest?.token;
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });
    const second = useUiStore.getState().browserOpenRequest?.token;

    expect(second).not.toBe(first);
    expect(second).toBeGreaterThan(first ?? 0);
  });

  /**
   * 请求**不是**消费一次就清掉的事件。
   *
   * 早先的实现让 BrowserPanel 读到就结算，结果是 StrictMode 下第二次挂载拿不到请求、
   * 留在 DOM 里的 webview 永远停在 about:blank（实测，见 BrowserPanel 那段注释）。
   * 现在它是一份**持续状态**：由 (元素, token) 决定要不要应用，所以这里钉住
   * 「重复调用只会换 token，不会把请求清掉」。
   */
  it("请求保持在 store 里（不清空），由消费方按 token 判重", () => {
    useUiStore.getState().openInBrowser({ url: "file:///D:/p/a.html", title: "a.html" });

    expect(useUiStore.getState().browserOpenRequest).not.toBeNull();
    expect(useUiStore.getState().browserOpenRequest?.token).toBeGreaterThan(0);
  });
});

describe("插件模态窗（pluginModal）", () => {
  /** 四个模态的开合状态都要清干净：互斥是在它们之间生效的 */
  function resetModals(): void {
    useUiStore.setState({
      searchOpen: false,
      settingsOpen: false,
      pluginsOpen: false,
      pluginModal: null,
    });
  }

  beforeEach(resetModals);

  it("打开之后它就是唯一开着的模态", () => {
    useUiStore.getState().openPlugins();
    useUiStore.getState().openPluginModal("dev.oint.scratchpad", "scratchpad");

    const state = useUiStore.getState();
    expect(state.pluginModal).toEqual({ pluginId: "dev.oint.scratchpad", surfaceId: "scratchpad" });
    expect(state.pluginsOpen).toBe(false);
    expect(state.settingsOpen).toBe(false);
    expect(state.searchOpen).toBe(false);
  });

  it("换一个插件的界面是替换，不是叠加（同一时刻只开一个）", () => {
    useUiStore.getState().openPluginModal("dev.a", "one");
    useUiStore.getState().openPluginModal("dev.b", "two");

    expect(useUiStore.getState().pluginModal).toEqual({ pluginId: "dev.b", surfaceId: "two" });
  });

  /**
   * 幂等不是"什么都不做"：状态对象**保持同一份引用**，于是 React 这边不会重挂
   * webview（重挂 = 页面重新加载，用户看到的是一闪），但另外三个模态仍然要被关掉。
   */
  it("重复打开同一个界面：引用不变，但另外三个模态仍然被关掉", () => {
    useUiStore.getState().openPluginModal("dev.a", "one");
    const before = useUiStore.getState().pluginModal;

    // 直接置位而不是 openSettings()：那个动作会顺手关掉这个模态，就不是"重复打开"了
    useUiStore.setState({ settingsOpen: true });
    useUiStore.getState().openPluginModal("dev.a", "one");

    expect(useUiStore.getState().pluginModal).toBe(before);
    expect(useUiStore.getState().settingsOpen).toBe(false);
  });

  it("打开另外三个模态中的任何一个，都会把它关掉", () => {
    for (const open of ["openSearch", "openSettings", "openPlugins"] as const) {
      useUiStore.getState().openPluginModal("dev.a", "one");
      useUiStore.getState()[open]();
      expect(useUiStore.getState().pluginModal, open).toBeNull();
    }
  });

  it("closePluginModal 只清它自己（另外三个模态的状态不受影响）", () => {
    useUiStore.getState().openPluginModal("dev.a", "one");
    useUiStore.setState({ pluginsOpen: true });

    useUiStore.getState().closePluginModal();

    expect(useUiStore.getState().pluginModal).toBeNull();
    expect(useUiStore.getState().pluginsOpen).toBe(true);
  });
});
