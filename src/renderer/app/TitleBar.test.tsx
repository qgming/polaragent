/**
 * 窗口控制在「内容区顶栏 ↔ 右侧栏顶行」之间的交接。
 *
 * 这是本次改动最容易悄悄坏掉的一处：窗口控制有三颗（最小化 / 最大化 / 关闭），
 * 分居两个组件；一旦两边的显示条件写反、或忘记加条件，屏幕上就会出现
 * **两组一模一样的按钮**，而这类问题在 code review 里看不出来（两边各自都对）。
 * 所以这里把「同一时刻只有一套可见」钉成断言。
 *
 * 断言口径按**容器**分别查（within(banner) / within(complementary)）而不是全屏计数：
 * 右侧栏收起时它的子树是 inert + 宽度 0，DOM 里仍留着那三颗按钮（保留是为了
 * 收起动画期间按钮跟着面板一起滑出去，而不是在动画开始时凭空消失）。
 * 按容器查能精确表达「哪一边在负责」，全屏计数会把这份刻意保留也算进来。
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TitleBar } from "@/renderer/app/TitleBar";
import { RightSidebar } from "@/renderer/features/right-panel/RightSidebar";
import i18n from "@/renderer/i18n";
import { useUiStore } from "@/renderer/stores/ui-store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  // TitleBar / WindowControls 只用到 window.* 这几个方法；
  // onMaximizedChange 必须返回取消订阅函数（未订阅就卸载会 TypeError）
  vi.stubGlobal("oint", {
    window: {
      minimize: () => Promise.resolve(),
      toggleMaximize: () => Promise.resolve(),
      close: () => Promise.resolve(),
      onMaximizedChange: () => () => {},
    },
    // RightSidebar 在挂载时订阅浏览器的「模型要用浏览器」事件；
    // onEvent 必须返回取消订阅函数，否则卸载时会 TypeError。
    browser: {
      status: () => Promise.resolve(null),
      onEvent: () => () => {},
    },
  });
  // 每个用例都从「收起」出发
  useUiStore.setState({ rightPanelOpen: false, rightPanelView: null });
});

/** 布局根：顶栏与右侧栏的兄弟关系就是 App.tsx 里的那一层，这里照搬以测量真实结构 */
function renderShell() {
  render(
    <div className="flex h-screen">
      <div className="flex flex-1 flex-col">
        <TitleBar />
      </div>
      <RightSidebar />
    </div>,
  );
  return {
    banner: screen.getByRole("banner"),
    aside: screen.getByRole("complementary"),
  };
}

describe("窗口控制在顶栏与右侧栏之间的交接", () => {
  it("右侧栏收起时：三颗控制都在顶栏里", () => {
    const { banner, aside } = renderShell();

    const inBanner = within(banner);
    expect(inBanner.getByLabelText("最小化")).toBeDefined();
    expect(inBanner.getByLabelText("最大化")).toBeDefined();
    expect(inBanner.getByLabelText("关闭窗口")).toBeDefined();

    // 收起态下右侧栏整棵子树 inert（隐藏期间不该被 Tab 命中）
    expect(aside.hasAttribute("inert")).toBe(true);
  });

  it("右侧栏展开时：顶栏不再有控制，控制移到侧边栏里", () => {
    useUiStore.setState({ rightPanelOpen: true });
    const { banner, aside } = renderShell();

    const inBanner = within(banner);
    expect(inBanner.queryByLabelText("最小化")).toBeNull();
    expect(inBanner.queryByLabelText("最大化")).toBeNull();
    expect(inBanner.queryByLabelText("关闭窗口")).toBeNull();

    const inAside = within(aside);
    expect(inAside.getByLabelText("最小化")).toBeDefined();
    expect(inAside.getByLabelText("最大化")).toBeDefined();
    expect(inAside.getByLabelText("关闭窗口")).toBeDefined();

    // 展开时不再是 inert（里面的按钮要能点）
    expect(aside.hasAttribute("inert")).toBe(false);
  });

  it("右侧栏展开后，面板内没有「收起面板」按钮 —— 开合只由顶栏那颗开关负责", () => {
    useUiStore.setState({ rightPanelOpen: true });
    const { aside } = renderShell();

    // 面板里没有任何收起/关闭面板的入口：那个动作只存在于顶栏那颗开关
    expect(within(aside).queryByLabelText("收起右侧面板")).toBeNull();
    // 选择列表就是第一屏，此时没有「返回」可点（已经在这一屏了）
    expect(within(aside).queryByLabelText("返回")).toBeNull();
  });

  it("顶栏那颗开关切换展开态（唯一开合入口），并切到面板的选择列表", async () => {
    const { banner, aside } = renderShell();

    const toggle = within(banner).getByLabelText("打开右侧面板");
    toggle.click();

    // 展开后：顶栏的控制让位、侧边栏接管，且第一屏是选择列表
    expect(await within(aside).findByLabelText("最小化")).toBeDefined();
    expect(within(banner).queryByLabelText("最小化")).toBeNull();
    expect(within(aside).getByText("审查")).toBeDefined();
    expect(within(aside).getByText("终端")).toBeDefined();
  });

  it("选择某个入口后头部显示该视图名，并按「返回」回到选择列表", async () => {
    useUiStore.setState({ rightPanelOpen: true });
    const { aside } = renderShell();

    // 选择列表里点「浏览器」
    within(aside).getByText("浏览器").click();

    // 面板头部换成该视图名（没有重复的标题行）
    expect(await within(aside).findByText("浏览器")).toBeDefined();
    // 侧边聊天 / 终端 这些入口文案随之消失（已离开选择列表）
    expect(within(aside).queryByText("侧边聊天")).toBeNull();

    // 返回回到选择列表
    within(aside).getByLabelText("返回").click();
    expect(await within(aside).findByText("侧边聊天")).toBeDefined();
  });
});
