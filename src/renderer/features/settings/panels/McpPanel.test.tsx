/**
 * 设置面板「MCP」分区的渲染测试（ui project / jsdom）。
 *
 * 挂真面板 + 真 settings store，只换掉 window.oint 这个进程边界。验的是**两层**这件事：
 *   · 页签「系统 / 用户」各自只列自己那一层，系统层没有「添加服务器」；
 *   · 系统预设的启停开关写进 systemMcpServerEnabled（而不是改配置本身）；
 *   · 系统预设没有删除按钮（只能启停），用户配置有；
 *   · 同 id 覆盖时两边各自给出一句方向正确的说明。
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { McpServerConfig, McpServerView } from "@/shared/contracts/mcp";
import type { PermissionRuleView } from "@/shared/contracts/permissions";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { McpPanel } from "./McpPanel";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

function config(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: "context7",
    name: "Context7",
    enabled: true,
    transport: "http",
    command: "",
    args: [],
    env: {},
    cwd: "",
    url: "https://mcp.context7.com/mcp",
    headers: {},
    createdAt: 0,
    ...overrides,
  };
}

function view(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    config: config(),
    state: { status: "ready", serverName: "Context7", tools: [] },
    source: "system",
    overridden: false,
    ...overrides,
  };
}

/** 系统层两台，分属两个领域分组：一台默认开着且已连接，一台停用 */
const SYSTEM_VIEWS: McpServerView[] = [
  view({
    config: config(),
    state: {
      status: "ready",
      serverName: "Context7",
      tools: [
        {
          name: "resolve-library-id",
          qualifiedName: "mcp__context7__resolve-library-id",
          description: "",
        },
      ],
    },
  }),
  view({
    config: config({
      id: "arxiv",
      name: "arXiv",
      enabled: false,
      url: "https://arxiv.caseyjhand.com/mcp",
    }),
    state: { status: "idle", tools: [] },
  }),
];

const USER_VIEW: McpServerView = view({
  config: config({
    id: "mcp-1a2b3c4d",
    name: "我的 server",
    transport: "stdio",
    command: "npx",
    args: ["-y", "some-mcp"],
    url: "",
    createdAt: 5,
  }),
  state: { status: "idle", tools: [] },
  source: "user",
});

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
function stubBridge(views: McpServerView[], rules: PermissionRuleView[] = []) {
  const list = vi.fn(async () => views);
  const reload = vi.fn(async () => views);
  const reconnect = vi.fn(async (_serverId: string) => views);
  const probe = vi.fn(async () => ({
    ok: true as const,
    serverName: "x",
    protocolVersion: "1",
    tools: [],
  }));
  const listRules = vi.fn(async () => rules);
  const addRule = vi.fn(async () => {});
  const removeRule = vi.fn(async () => {});
  const write = vi.fn(async (_next: Settings) => {});
  vi.stubGlobal("oint", {
    mcp: { list, reload, reconnect, probe },
    permissions: { listRules, addRule, removeRule },
    settings: { read: vi.fn(async () => settingsFixture()), write },
  });
  return { list, reload, reconnect, probe, listRules, addRule, removeRule, write };
}

/** 卡片定位：标题所在的那一块（ServerCard 的根 div 是 rounded-xl） */
function cardFor(name: string): HTMLElement {
  const title = screen.getByText(name);
  const card = title.closest("div.rounded-xl");
  if (!(card instanceof HTMLElement)) throw new Error(`找不到「${name}」的卡片`);
  return card;
}

describe("McpPanel", () => {
  beforeEach(() => {
    useSettingsStore.setState({ settings: settingsFixture(), loaded: true });
  });

  it("默认落在「系统」页签：列系统预设、给说明、按领域分组，且没有「添加服务器」", async () => {
    stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    expect(await screen.findByText("Context7")).toBeTruthy();
    expect(screen.getByText("arXiv")).toBeTruthy();
    // 说明来自注册表的 i18n 键（品牌名不翻译，说明跟着界面语言走）
    expect(screen.getByText(/任意库与框架的最新版本文档与代码示例/)).toBeTruthy();
    // 三十多台预设按领域分组：不分组的话一屏平铺，找「有没有天气类的」只能靠眼扫
    expect(screen.getByText("知识与百科")).toBeTruthy();
    expect(screen.getByText("学术与科学")).toBeTruthy();
    expect(screen.queryByText("我的 server")).toBeNull();
    expect(screen.queryByRole("button", { name: "添加服务器" })).toBeNull();
  });

  /**
   * 系统预设一律允许，面板上不该出现免审批开关 ——
   * 一个永远该开着的开关只会让人怀疑「关掉会怎样」。
   */
  it("系统预设卡片上只有「启用」一个开关：没有免审批开关", async () => {
    stubBridge(SYSTEM_VIEWS);
    render(<McpPanel />);

    await screen.findByText("Context7");
    const card = cardFor("Context7");
    expect(within(card).getAllByRole("switch")).toHaveLength(1);
    expect(within(card).queryByText("信任该服务器的全部工具")).toBeNull();
  });

  it("面板上没有工具暴露策略选项（一律聚合，不给选择）", async () => {
    stubBridge(SYSTEM_VIEWS);
    render(<McpPanel />);

    await screen.findByText("Context7");
    expect(screen.queryByText("工具暴露策略")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "工具暴露策略" })).toBeNull();
  });

  it("切到「用户」页签：只列用户配置，并给「添加服务器」", async () => {
    stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "用户" }));

    expect(screen.getByText("我的 server")).toBeTruthy();
    expect(screen.queryByText("Context7")).toBeNull();
    expect(screen.getByRole("button", { name: "添加服务器" })).toBeTruthy();
  });

  it("用户页签没有配置时给用户空态", async () => {
    stubBridge(SYSTEM_VIEWS);
    render(<McpPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "用户" }));

    expect(screen.getByText("还没有配置 MCP server")).toBeTruthy();
    expect(screen.queryByText("没有内置 MCP 预设")).toBeNull();
  });

  it("系统预设只能启停：卡片上没有更多操作菜单，用户配置上有", async () => {
    stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    await screen.findByText("Context7");
    expect(within(cardFor("Context7")).queryByRole("button", { name: "更多操作" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "用户" }));
    expect(within(cardFor("我的 server")).getByRole("button", { name: "更多操作" })).toBeTruthy();
  });

  /**
   * 卡片右上角每台一个「重新连接」：只重连这一台（走 mcp.reconnect），
   * 不是整页 reload —— 后者会按设置对账整张连接表，把别人的连接也一起动。
   */
  it("每张卡片都有独立的重新连接按钮，只重连这一台", async () => {
    const bridge = stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    await screen.findByText("Context7");
    fireEvent.click(within(cardFor("Context7")).getByRole("button", { name: "重新连接" }));

    await waitFor(() => expect(bridge.reconnect).toHaveBeenCalledWith("context7"));
    expect(bridge.reload).not.toHaveBeenCalled();

    // 用户页签的卡片同样有
    fireEvent.click(screen.getByRole("button", { name: "用户" }));
    fireEvent.click(within(cardFor("我的 server")).getByRole("button", { name: "重新连接" }));
    await waitFor(() => expect(bridge.reconnect).toHaveBeenCalledWith("mcp-1a2b3c4d"));
  });

  it("删除收进「更多操作」菜单：点开后才有删除，避免误点不可撤销的动作", async () => {
    stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "用户" }));
    const card = cardFor("我的 server");
    // 菜单没打开时，卡片里没有裸的删除按钮
    expect(within(card).queryByRole("menuitem", { name: "删除" })).toBeNull();

    // Radix 的菜单在 pointerdown 上打开（不是 click）：jsdom 里必须发 pointerDown
    fireEvent.pointerDown(within(card).getByRole("button", { name: "更多操作" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(await screen.findByRole("menuitem", { name: "删除" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "编辑服务器" })).toBeTruthy();
  });

  it("关掉一个系统预设：写进 systemMcpServerEnabled 并触发重连", async () => {
    const bridge = stubBridge(SYSTEM_VIEWS);
    render(<McpPanel />);

    await screen.findByText("Context7");
    const card = cardFor("Context7");
    fireEvent.click(within(card).getAllByRole("switch")[0] as HTMLElement);

    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls[0]?.[0]).toMatchObject({
      systemMcpServerEnabled: { context7: false },
    });
    // 只改显式启停表，不动预设配置本身
    expect(bridge.write.mock.calls[0]?.[0]?.mcpServers).toEqual([]);
    await waitFor(() => expect(bridge.reload).toHaveBeenCalled());
  });

  /**
   * 用户配置的卡片上也有启用开关（过去只能进编辑器改，卡片上没有）。
   * 它改的是 `mcpServers` 里那一条自己的 `enabled` —— 与系统预设的「显式选择表」不同。
   */
  it("用户配置卡片有两个开关（启用 + 免审批），停用写回 mcpServers", async () => {
    // 用户配置住在 settings.mcpServers 里：启停开关改的就是那一条自己
    useSettingsStore.setState({
      settings: settingsFixture({ mcpServers: [USER_VIEW.config] }),
      loaded: true,
    });
    const bridge = stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "用户" }));
    const card = cardFor("我的 server");
    expect(within(card).getAllByRole("switch")).toHaveLength(2);

    fireEvent.click(within(card).getAllByRole("switch")[0] as HTMLElement);

    await waitFor(() => expect(bridge.write).toHaveBeenCalled());
    expect(bridge.write.mock.calls[0]?.[0]).toMatchObject({
      mcpServers: [expect.objectContaining({ id: "mcp-1a2b3c4d", enabled: false })],
    });
    // 不是写系统预设的启停表
    expect(bridge.write.mock.calls[0]?.[0]?.systemMcpServerEnabled).toEqual({});
    await waitFor(() => expect(bridge.reload).toHaveBeenCalled());
  });

  it("启用与免审批两个开关都不带说明文字（卡片只留标签）", async () => {
    stubBridge([...SYSTEM_VIEWS, USER_VIEW]);
    render(<McpPanel />);

    fireEvent.click(await screen.findByRole("button", { name: "用户" }));
    await screen.findByText("我的 server");

    expect(screen.queryByText("停用会断开连接，该 server 的工具也不再暴露给模型")).toBeNull();
    expect(
      screen.queryByText("开启后不再逐次弹出审批卡（写入 mcp__<服务器 ID>__* 规则）"),
    ).toBeNull();
  });

  it("同 id 覆盖：系统行说「已被你的同名配置覆盖」，用户行说「正在覆盖系统预设」", async () => {
    const systemShadowed = view({
      config: config(),
      state: { status: "idle", tools: [] },
      overridden: true,
    });
    const userShadowing = view({
      config: config({ name: "我的 Context7", url: "https://mine.example/mcp", createdAt: 9 }),
      state: { status: "ready", serverName: "mine", tools: [] },
      source: "user",
      overridden: true,
    });
    stubBridge([systemShadowed, userShadowing]);
    render(<McpPanel />);

    expect(await screen.findByText("已被你的同名配置覆盖")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "用户" }));
    expect(screen.getByText("正在覆盖系统预设")).toBeTruthy();
  });
});
