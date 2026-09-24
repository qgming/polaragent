/**
 * 右侧面板注册表。
 *
 * 这一组替代了过去散在两处的断言：
 *  - ui-store.test.ts 的「RIGHT_PANEL_VIEWS 不含 file」（顺序表）
 *  - 以及根本不存在、但过去靠穷举 Record 的**编译错误**兜住的那些（panel-meta）
 *
 * 现在两者都收敛到注册表上，于是"漏改一处"从**编译期**变成了**运行期** ——
 * 这正是下面这些用例存在的理由：它们把过去编译器替我们盯着的事接了过来。
 */

import { describe, expect, it } from "vitest";
import { chooseablePanels, getPanel, listPanels, panelShortcuts, registerPanel } from "./panels";

/**
 * 取一个内置面板的图标。
 *
 * 用会抛错的助手而不是 `!`：本仓库禁非空断言（biome 的 noNonNullAssertion），
 * 而且「内置面板不见了」时抛出的信息比一个 undefined 更有用。
 */
function iconOf(view: string) {
  const panel = getPanel(view);
  if (panel === undefined) throw new Error(`内置面板 ${view} 未注册`);
  return panel.Icon;
}

describe("内置面板", () => {
  it("六个都注册上了", () => {
    const views = listPanels().map((panel) => panel.view);
    for (const view of ["review", "files", "file", "subagent", "browser", "terminal"]) {
      expect(views, `${view} 应该已注册`).toContain(view);
    }
  });

  it("注册顺序即显示顺序，与过去的 RIGHT_PANEL_VIEWS 一致", () => {
    expect(listPanels().map((panel) => panel.view)).toEqual([
      "review",
      "files",
      "file",
      "subagent",
      "browser",
      "terminal",
    ]);
  });

  it("**file 不在选择列表里**：它是点文件卡片的结果，不是用户挑出来的视图", () => {
    expect(chooseablePanels().map((panel) => panel.view)).toEqual([
      "review",
      "files",
      "subagent",
      "browser",
      "terminal",
    ]);
    expect(getPanel("file")?.chooseable).toBe(false);
  });

  it("每个面板都有图标与文案键 —— 缺了会画出没有名字的标签", () => {
    for (const panel of listPanels()) {
      expect(panel.Icon, `${panel.view} 缺图标`).toBeDefined();
      expect(panel.labelKey, `${panel.view} 缺文案键`).not.toBe("");
    }
  });
});

describe("快捷键", () => {
  it("只有 files 与 browser 带快捷键", () => {
    expect(panelShortcuts()).toEqual([
      { key: "p", view: "files" },
      { key: "t", view: "browser" },
    ]);
  });

  it("键是小写的 —— 判定时用 event.key.toLowerCase()，大写永远匹配不上", () => {
    for (const entry of panelShortcuts()) {
      expect(entry.key).toBe(entry.key.toLowerCase());
    }
  });
});

describe("常驻标志", () => {
  it("**只有浏览器常驻**：它靠 display:none 让 guest 活过切换", () => {
    const resident = listPanels()
      .filter((panel) => panel.resident === true)
      .map((panel) => panel.view);
    expect(resident).toEqual(["browser"]);
  });
});

describe("registerPanel 的注册表语义", () => {
  it("重复注册抛错而不是静默覆盖", () => {
    // 覆盖是静默的：两个面板用同一个 view 时后注册的会悄悄顶掉前一个，
    // 而用户看到的是「某个面板坏了」。抛出去至少能记成一条可读的加载错误。
    expect(() =>
      registerPanel({
        view: "review",
        labelKey: "rightPanel.review",
        Icon: iconOf("review"),
        chooseable: true,
        content: () => null,
      }),
    ).toThrow(/已被注册/);
  });

  it("disposer 只删自己注册的那一项", () => {
    const dispose = registerPanel({
      view: "test:disposable",
      labelKey: "rightPanel.terminal",
      Icon: iconOf("terminal"),
      chooseable: true,
      content: () => null,
    });
    expect(getPanel("test:disposable")).toBeDefined();

    dispose();
    expect(getPanel("test:disposable")).toBeUndefined();
    // 内置项一个都没被带走
    expect(listPanels().map((panel) => panel.view)).toEqual([
      "review",
      "files",
      "file",
      "subagent",
      "browser",
      "terminal",
    ]);
  });

  it("注册 → 注销 → 再注册之后，旧的 disposer 不会误删新的那一项", () => {
    const descriptor = {
      view: "test:re-registered",
      labelKey: "rightPanel.terminal",
      Icon: iconOf("terminal"),
      chooseable: true,
      content: () => null,
    };
    const firstDispose = registerPanel(descriptor);
    firstDispose();

    const secondDispose = registerPanel(descriptor);
    // 旧 disposer 再调一次（插件卸载路径可能重复调用）不该删掉新的
    firstDispose();
    expect(getPanel("test:re-registered")).toBeDefined();
    secondDispose();
  });

  it("查不到的 view 返回 undefined（界面据此画「这个面板已经不可用」）", () => {
    expect(getPanel("plugin:gone:forever")).toBeUndefined();
  });
});
