/**
 * 设置面板「魔法提示」分区的渲染测试（ui project / jsdom）。
 *
 * 挂真面板 + 真 settings store，只换掉 window.oint 这个进程边界。验的是：
 *   · 默认「用户」页签只列磁盘上扫描到的模板，「系统」页签只列内置模板；
 *   · 系统页签为空时给系统空态文案；
 *   · 工具栏的「新建」与点击已有模板共用同一个编辑弹窗（保存走 write，重命名带原名）。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { PromptTemplateInfo, PromptTemplateWriteRequest } from "@/shared/contracts/prompts";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { PromptsPanel } from "./PromptsPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const USER_TEMPLATE: PromptTemplateInfo = {
  name: "translate",
  description: "翻译成中文",
  content: "把下面这段内容翻译成中文：",
  source: "user",
  dir: "C:\\Users\\me\\.oint\\prompts",
};

const BUILTIN_TEMPLATE: PromptTemplateInfo = {
  name: "explain",
  description: "解释选中的代码",
  content: "逐行解释选中的代码：",
  source: "builtin",
  dir: "/app/prompts",
};

function settingsFixture(overrides: Partial<Settings> = {}): Settings {
  return {
    theme: "light",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [],
    defaultModel: null,
    thinkingLevel: "medium",
    permissionMode: "default",
    agentMode: "standard",
    disabledSkillNames: [],
    disabledSubagentNames: [],
    mcpServers: [],
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    ...overrides,
  };
}

/** 只补这条链真的会调到的通道 */
function stubBridge(templates: PromptTemplateInfo[]) {
  const list = vi.fn(async () => templates);
  const write = vi.fn(async (_request: PromptTemplateWriteRequest) => USER_TEMPLATE);
  const remove = vi.fn(async (_name: string) => {});
  vi.stubGlobal("oint", {
    prompts: { list, write, remove },
    settings: { read: vi.fn(async () => settingsFixture()), write: vi.fn(async () => {}) },
  });
  return { list, write, remove };
}

describe("PromptsPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loaded: true });
  });

  it("默认「用户」页签：只列用户模板", async () => {
    stubBridge([USER_TEMPLATE, BUILTIN_TEMPLATE]);
    render(<PromptsPanel />);

    expect(await screen.findByText("translate")).toBeTruthy();
    expect(screen.queryByText("explain")).toBeNull();
  });

  it("切到「系统」页签：只列内置模板", async () => {
    stubBridge([USER_TEMPLATE, BUILTIN_TEMPLATE]);
    render(<PromptsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));

    expect(screen.getByText("explain")).toBeTruthy();
    expect(screen.queryByText("translate")).toBeNull();
  });

  it("系统页签没有内置模板时给系统空态", async () => {
    stubBridge([USER_TEMPLATE]);
    render(<PromptsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));

    expect(screen.getByText("内置魔法提示没有加载到")).toBeTruthy();
    expect(screen.queryByText("还没有发现模板")).toBeNull();
  });

  /**
   * 内置提示**只能看不能改**：它们住在应用目录里，改它等于改应用自身，升级时还会被整包替换。
   * 所以点开的是只读查看器 —— 没有保存、没有删除，并且明说「想改就新建同名提示」。
   */
  it("点内置模板打开只读查看器：没有保存与删除，并给出同名覆盖的指引", async () => {
    stubBridge([BUILTIN_TEMPLATE]);
    render(<PromptsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));
    fireEvent.click(screen.getByRole("button", { name: /explain/ }));

    expect(await screen.findByText("查看内置魔法提示")).toBeTruthy();
    // 列表里也有这条正文预览，所以断言要落在弹窗内部
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("逐行解释选中的代码：")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(within(dialog).getByText(/新建一份同名提示/)).toBeTruthy();
  });

  it("系统页签不给「新建」入口（新建只作用于用户目录）", async () => {
    stubBridge([USER_TEMPLATE, BUILTIN_TEMPLATE]);
    render(<PromptsPanel />);

    expect(await screen.findByRole("button", { name: "新建魔法提示" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "系统" }));
    expect(screen.queryByRole("button", { name: "新建魔法提示" })).toBeNull();
  });

  it("新建：工具栏按钮打开同一个弹窗，保存走 write 并带上规范化后的名称", async () => {
    const bridge = stubBridge([]);
    render(<PromptsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "新建魔法提示" }));

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Translate Me" } });
    fireEvent.change(screen.getByLabelText("正文"), {
      target: { value: "把下面这段内容翻译成中文：" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls[0]?.[0]).toMatchObject({
      name: "translate-me",
      content: "把下面这段内容翻译成中文：",
    });
  });

  it("点已有模板打开编辑弹窗：字段预填，保存带上原名", async () => {
    const bridge = stubBridge([USER_TEMPLATE]);
    render(<PromptsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /translate/ }));

    const name = (await screen.findByLabelText("名称")) as HTMLInputElement;
    const description = screen.getByLabelText("描述") as HTMLInputElement;
    const content = screen.getByLabelText("正文") as HTMLTextAreaElement;
    expect(name.value).toBe("translate");
    expect(description.value).toBe("翻译成中文");
    expect(content.value).toBe("把下面这段内容翻译成中文：");

    fireEvent.change(description, { target: { value: "换个说法" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls[0]?.[0]).toMatchObject({
      originalName: "translate",
      name: "translate",
      description: "换个说法",
    });
  });
});
