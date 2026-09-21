/**
 * 设置面板「子智能体」分区的渲染测试（ui project / jsdom）。
 *
 * 挂的是真面板 + 真 settings store，只换掉 window.oint 这个进程边界。验的是几条
 * 用户能看见的契约：
 *   · 默认「用户」页签只列自定义定义；「系统」页签只列内置预设（不可编辑 / 删除）；
 *   · 目录为空时给空态，解析失败的诊断照常显示（不能静默消失）；
 *   · 行开关写进 disabledSubagentNames —— 启用状态存在设置里，不写进 .md；
 *   · 编辑器在名称不合法、描述为空、正文为空时拒绝落盘；
 *   · 编辑时 read() 的原文按 frontmatter 切开，保存带上原名（重命名要能定位旧文件）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { Settings } from "@/shared/contracts/settings";
import type {
  SubagentCatalog,
  SubagentInfo,
  SubagentWriteRequest,
} from "@/shared/contracts/subagent";
import { SubagentsPanel } from "./SubagentsPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const USER_ROW: SubagentInfo = {
  name: "helper",
  description: "改代码的小工",
  tools: ["read", "bash"],
  model: null,
  thinkingLevel: null,
  source: "user",
  enabled: true,
  filePath: "D:\\oint\\subagents\\helper.md",
  promptPreview: "先看再改",
};

const BUILTIN_ROW: SubagentInfo = {
  name: "explore",
  description: "调研代码库",
  tools: ["read", "grep", "glob"],
  model: { serviceId: "svc", modelId: "m1" },
  thinkingLevel: "medium",
  source: "builtin",
  enabled: true,
  promptPreview: "看清再答",
};

/** 最小可用的设置形状：除了面板真的会读的字段，其余按契约填默认值 */
function settingsFixture(overrides: Partial<Settings>): Settings {
  return {
    theme: "light",
    language: "zh-CN",
    density: "comfortable",
    chatFont: "",
    chatFontSize: 14,
    services: [
      {
        id: "svc",
        name: "本地服务",
        baseUrl: "https://api.test/v1",
        apiKey: "",
        wireFormat: "openai-completions",
        models: [{ id: "m1", name: "小模型" }],
      },
    ],
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

function seedSettings(overrides: Partial<Settings> = {}) {
  useSettingsStore.setState({ settings: settingsFixture(overrides), loaded: true });
}

/** 只补这条链真的会调到的通道；IPC 调用记下来供断言 */
function stubBridge(catalog: SubagentCatalog) {
  const list = vi.fn(async () => catalog);
  const read = vi.fn(async (name: string) => ({
    name,
    content: "---\nname: helper\ndescription: 改代码的小工\n---\n先看再改",
  }));
  const write = vi.fn(
    async (request: SubagentWriteRequest): Promise<SubagentInfo> => ({
      ...USER_ROW,
      name: request.name,
    }),
  );
  const remove = vi.fn(async () => {});
  const reveal = vi.fn(async () => ({ ok: true }));
  vi.stubGlobal("oint", {
    subagents: { list, read, write, remove, reveal },
    // 行开关经 store 落盘：settings.write 缺了会走回滚分支，禁用名单就断言不到
    settings: { read: vi.fn(async () => settingsFixture({})), write: vi.fn(async () => {}) },
  });
  return { list, read, write, remove, reveal };
}

describe("SubagentsPanel", () => {
  beforeEach(() => {
    seedSettings();
  });

  it("目录为空时给空态，解析失败的诊断照常显示", async () => {
    stubBridge({ subagents: [], diagnostics: ["D:\\oint\\subagents\\broken.md 解析失败"] });
    render(<SubagentsPanel />);

    expect(await screen.findByText("还没有自定义子智能体")).toBeTruthy();
    expect(screen.getByText("新建一个，或在数据目录的 subagents 里放置 .md 定义")).toBeTruthy();
    expect(screen.getByText(/解析失败/)).toBeTruthy();
  });

  it("默认「用户」页签：只列自定义定义，行内给定位 / 删除，整行可点开编辑", async () => {
    stubBridge({ subagents: [USER_ROW, BUILTIN_ROW], diagnostics: [] });
    render(<SubagentsPanel />);

    expect(await screen.findByText("helper")).toBeTruthy();
    // 内置预设不在用户页签里露面
    expect(screen.queryByText("explore")).toBeNull();
    // 只读 / 可写的摘要徽标按工具清单判定：helper 带 bash
    expect(screen.getByText("可写文件")).toBeTruthy();
    expect(screen.getByRole("button", { name: "在文件夹中显示" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新建子智能体" })).toBeTruthy();
    expect(screen.getAllByRole("switch", { name: /helper/ })).toHaveLength(1);
  });

  it("切到「系统」页签：只列内置预设，只有开关与提示、没有行内动作", async () => {
    stubBridge({ subagents: [USER_ROW, BUILTIN_ROW], diagnostics: [] });
    render(<SubagentsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));

    expect(screen.getByText("explore")).toBeTruthy();
    expect(screen.queryByText("helper")).toBeNull();
    expect(screen.getByText("只读")).toBeTruthy();
    expect(screen.getByText("内置预设：随应用提供，可禁用但不可编辑或删除")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "在文件夹中显示" })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    // 新建只会落在数据目录（用户定义），系统页签不给入口
    expect(screen.queryByRole("button", { name: "新建子智能体" })).toBeNull();
    expect(screen.getAllByRole("switch", { name: /explore/ })).toHaveLength(1);
  });

  it("点内置预设打开同一个弹窗：只读展示，没有保存按钮", async () => {
    const bridge = stubBridge({ subagents: [BUILTIN_ROW], diagnostics: [] });
    render(<SubagentsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "系统" }));
    fireEvent.click(await screen.findByRole("button", { name: /explore/ }));
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith("explore"));

    const name = (await screen.findByLabelText("名称")) as HTMLInputElement;
    expect(name.value).toBe("explore");
    expect(name.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("行开关把定义名写进 / 移出 disabledSubagentNames", async () => {
    stubBridge({ subagents: [USER_ROW, BUILTIN_ROW], diagnostics: [] });
    render(<SubagentsPanel />);

    fireEvent.click(await screen.findByRole("switch", { name: /helper/ }));
    expect(useSettingsStore.getState().settings?.disabledSubagentNames).toEqual(["helper"]);

    fireEvent.click(screen.getByRole("switch", { name: /helper/ }));
    expect(useSettingsStore.getState().settings?.disabledSubagentNames).toEqual([]);
  });

  it("空表单保存被拒：名称 / 描述 / 正文三处都标出来，一条不落盘", async () => {
    const bridge = stubBridge({ subagents: [], diagnostics: [] });
    render(<SubagentsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "新建子智能体" }));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByText("名称只能是小写字母、数字与短横线，且不超过 40 个字符")).toBeTruthy();
    expect(screen.getByText("描述不能为空")).toBeTruthy();
    expect(screen.getByText("系统提示不能为空")).toBeTruthy();
    await waitFor(() => expect(bridge.write).not.toHaveBeenCalled());
  });

  it("编辑：点行打开弹窗，read 的原文只把正文放进编辑框，保存带上原名", async () => {
    const bridge = stubBridge({ subagents: [USER_ROW], diagnostics: [] });
    render(<SubagentsPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /helper/ }));
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith("helper"));

    const prompt = (await screen.findByLabelText("系统提示")) as HTMLTextAreaElement;
    // frontmatter 不是正文：它由主进程按结构化字段重新序列化
    expect(prompt.value).toBe("先看再改");

    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls[0]?.[0]).toMatchObject({
      originalName: "helper",
      name: "helper",
      prompt: "先看再改",
      tools: ["read", "bash"],
    });
  });
});
