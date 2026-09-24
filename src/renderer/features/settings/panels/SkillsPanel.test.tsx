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
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
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

/**
 * 跨工具共享目录里的技能（`~/.agents/skills`）。
 *
 * 它的三个特点各有对应用例：进「全局」页签、**能禁用**、**不能删除**。
 */
const SHARED_SKILL: SkillInfo = {
  name: "pdf",
  description: "排版成 PDF",
  filePath: "C:\\Users\\me\\.agents\\skills\\pdf\\SKILL.md",
  source: "agents",
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
    systemMcpServerEnabled: {},
    webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
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
  // 参数声明成 Settings：调用方（settings-store 的 update）会传整份设置，
  // 而断言要读 `mock.calls.at(-1)[0]` —— 不声明参数的话元组类型是 `[]`，取不出第 0 项
  const write = vi.fn(async (_next: Settings) => {});
  vi.stubGlobal("oint", {
    skills: { list, import: importSkills, read, remove },
    settings: { read: vi.fn(async () => settingsFixture()), write },
  });
  return { list, importSkills, read, remove, write };
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

  it("「全局」页签：只列跨工具共享目录里的技能", async () => {
    stubBridge([USER_SKILL, SHARED_SKILL, BUILTIN_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "全局" }));

    expect(screen.getByText("pdf")).toBeTruthy();
    expect(screen.queryByText("review")).toBeNull();
    expect(screen.queryByText("commit-style")).toBeNull();
  });

  it("全局页签的空态用自己的文案（不能指路到数据目录）", async () => {
    stubBridge([USER_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "全局" }));

    expect(screen.getByText("跨工具共享目录里还没有技能")).toBeTruthy();
    expect(screen.queryByText("还没有发现技能")).toBeNull();
  });

  /**
   * **本地开关**：共享来源的技能与其余来源一样可禁用/启用。
   *
   * 禁用名单按名字匹配、与来源无关（`settings.disabledSkillNames`），所以这一档
   * 不需要任何额外机制 —— 这条用例钉的正是"不需要额外机制"这件事：一旦有人给
   * 共享来源加了单独的开关字段，它会红。
   */
  it("共享来源的技能可以本地开关：写进 disabledSkillNames", async () => {
    const bridge = stubBridge([SHARED_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "全局" }));
    fireEvent.click(screen.getByRole("switch", { name: "pdf · 启用" }));

    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls.at(-1)?.[0]).toMatchObject({ disabledSkillNames: ["pdf"] });
  });

  /**
   * 共享来源的技能**不给删除按钮**，且底部的说明与内置那条不同。
   *
   * 界面与主进程两处都要挡（`ipc/skills.ts` 的 remove 会拒绝），这条只验界面这一半：
   * 一个点下去只会报错的按钮比没有按钮更糟。
   */
  it("共享来源的技能：详情里没有删除按钮，说明指向「禁用」", async () => {
    stubBridge([SHARED_SKILL]);
    render(<SkillsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "全局" }));
    fireEvent.click(await screen.findByRole("button", { name: /pdf/ }));

    expect(await screen.findByText(/删掉会让别的工具一起丢技能/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  });
});
