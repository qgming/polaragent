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
