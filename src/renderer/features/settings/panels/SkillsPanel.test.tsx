/**
 * 设置面板「技能」分区的渲染测试（ui project / jsdom）。
 *
 * 挂真面板 + 真 settings store，只换掉 window.oint 这个进程边界。验的是：
 *   · 默认「用户」页签只列磁盘上扫描到的技能，「系统」页签只列内置技能；
 *   · 两个页签各自的空态文案不混用；
 *   · 「导入技能（.zip）」走导入通道并报出结果；点行打开详情、删除走二次确认。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillInfo } from "@/shared/contracts/skills";
import { SkillsPanel } from "./SkillsPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const USER_SKILL: SkillInfo = {
  name: "review",
  description: "看一遍改动",
  filePath: "C:\\Users\\me\\.oint\\skills\\review\\SKILL.md",
  source: "user",
  disabled: false,
};

const BUILTIN_SKILL: SkillInfo = {
  name: "commit-style",
  description: "提交信息规范",
  filePath: "/app/skills/commit-style/SKILL.md",
  source: "builtin",
  disabled: false,
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
    ...overrides,
  };
}

/** 只补这条链真的会调到的通道 */
function stubBridge(skills: SkillInfo[]) {
  const list = vi.fn(async () => skills);
  const importSkills = vi.fn(async () => ({
    canceled: false,
    files: 3,
    skills: 1,
    diagnostics: [] as string[],
  }));
  const read = vi.fn(async (name: string) => ({
    name,
    description: "看一遍改动",
    filePath: `C:\\Users\\me\\.oint\\skills\\${name}\\SKILL.md`,
    content: "# review\n\n正文",
  }));
  const remove = vi.fn(async () => {});
  vi.stubGlobal("oint", {
    skills: { list, import: importSkills, read, remove },
    settings: { read: vi.fn(async () => settingsFixture()), write: vi.fn(async () => {}) },
  });
  return { list, importSkills, read, remove };
}

describe("SkillsPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loaded: true });
  });

  it("默认「用户」页签：只列用户技能", async () => {
    stubBridge([USER_SKILL, BUILTIN_SKILL]);
    render(<SkillsPanel />);

    expect(await screen.findByText("review")).toBeTruthy();
    expect(screen.queryByText("commit-style")).toBeNull();
  });

  it("切到「系统」页签：只列内置技能", async () => {
    stubBridge([USER_SKILL, BUILTIN_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));

    expect(screen.getByText("commit-style")).toBeTruthy();
    expect(screen.queryByText("review")).toBeNull();
  });

  it("系统页签没有内置技能时给系统空态，不混用用户空态", async () => {
    stubBridge([USER_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));

    expect(screen.getByText("还没有内置技能")).toBeTruthy();
    expect(screen.queryByText("还没有发现技能")).toBeNull();
  });

  it("导入 zip：走导入通道，刷新列表并报出文件数与技能数", async () => {
    const bridge = stubBridge([USER_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /导入技能/ }));

    await waitFor(() => expect(bridge.importSkills).toHaveBeenCalled());
    expect(await screen.findByText("已导入 3 个文件，识别到 1 个技能")).toBeTruthy();
    // 导入后要重新拉列表（初始一次 + 导入后一次）
    expect(bridge.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("点技能行打开详情：显示 SKILL.md 原文，删除走二次确认", async () => {
    const bridge = stubBridge([USER_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /review/ }));
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith("review"));
    expect(await screen.findByText(/正文/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    // 二次确认框里再点一次删除才真正落盘
    const confirmButtons = await screen.findAllByRole("button", { name: "删除" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1] as HTMLElement);

    await waitFor(() => expect(bridge.remove).toHaveBeenCalledWith("review"));
  });
});
