/**
 * plugins-store 的加载与降级规则（node project，store 本身不依赖 DOM）。
 *
 * 钉的是三条**用户直接看得见的行为**：
 *  1. 运行时未接入时**不抛错**，降级为空列表 + 一行诊断（模态窗因此能先于运行时上线）；
 *  2. 操作失败时**不清空列表**（失败不该让用户丢掉正在看的东西）；
 *  3. 变更类操作以主进程返回的**完整列表**为准替换（渲染层不做乐观更新）。
 *
 * window.oint 是 store 唯一的外部依赖（IPC），逐条用例换成替身；不 mock 模块。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginView } from "@/shared/contracts/plugin";
import { usePluginsStore } from "./plugins-store";

/** 一行插件；各用例只改自己关心的那几项 */
function viewFixture(patch: Partial<PluginView> = {}): PluginView {
  return {
    id: "com.example.git-lens",
    name: "Git Lens",
    version: "1.0.0",
    description: "Git 管理",
    source: "user",
    removable: true,
    enabled: true,
    state: "running",
    contributions: {
      panels: 1,
      modals: 0,
      windows: 0,
      commands: 0,
      skills: 0,
      prompts: 0,
      subagents: 0,
      mcpServers: 0,
      tools: 0,
    },
    permissions: [{ id: "ui.panel", risk: "low" }],
    newlyRequested: [],
    contributionNames: { skills: [], prompts: [], subagents: [], mcpServers: [] },
    hooks: [],
    hasMain: false,
    surfaces: [
      {
        id: "git",
        kind: "panel",
        title: "Git",
        url: "oint-plugin://surface/dev.example.git-lens/ui/git.html",
        partition: "persist:oint-plugin-dev-example-git-lens",
      },
    ],
    ...patch,
  };
}

/** 一组可逐项覆写的 IPC 替身 */
function stubApi(overrides: Record<string, unknown> = {}) {
  const api = {
    list: vi.fn(async () => [viewFixture()]),
    enable: vi.fn(async () => ({ views: [viewFixture()], diagnostics: [] })),
    disable: vi.fn(async () => ({ views: [viewFixture({ enabled: false })], diagnostics: [] })),
    reload: vi.fn(async () => ({ views: [viewFixture()], diagnostics: [] })),
    install: vi.fn(async () => ({ canceled: false, views: [viewFixture()], diagnostics: [] })),
    uninstall: vi.fn(async () => ({ views: [], diagnostics: [] })),
    loadDev: vi.fn(async () => ({ canceled: false, views: [], diagnostics: [] })),
    openSurface: vi.fn(async () => undefined),
    revealData: vi.fn(async () => ({ ok: true })),
    diagnostics: vi.fn(async () => []),
    ...overrides,
  };
  vi.stubGlobal("window", { oint: { plugins: api } });
  return api;
}

/** 每条用例都从干净状态开始：store 是模块级单例，状态会跨用例残留 */
function resetStore() {
  usePluginsStore.setState({
    views: null,
    unavailable: null,
    diagnostics: null,
    busyId: null,
    error: null,
  });
}

beforeEach(() => {
  resetStore();
  vi.unstubAllGlobals();
});

describe("load", () => {
  it("成功后写入列表并清掉 unavailable", async () => {
    stubApi();
    await usePluginsStore.getState().load();
    const state = usePluginsStore.getState();
    expect(state.views).toHaveLength(1);
    expect(state.unavailable).toBeNull();
  });

  it("运行时未接入时降级为空列表 + 诊断，**不抛错**", async () => {
    // 验收判据 5：IPC 通道不存在时界面该显示空态，而不是白屏或红屏。
    stubApi({
      list: vi.fn(async () => {
        throw new Error("Error invoking remote method 'plugins:list': Error: 没有注册处理器");
      }),
    });
    await expect(usePluginsStore.getState().load()).resolves.toBeUndefined();
    const state = usePluginsStore.getState();
    expect(state.views).toEqual([]);
    expect(state.unavailable).not.toBeNull();
    // 前缀噪音被剥掉，只留主进程写的中文说明
    expect(state.unavailable).not.toContain("Error invoking remote method");
  });
});

describe("setEnabled", () => {
  it("以主进程返回的完整列表为准替换", async () => {
    const api = stubApi();
    await usePluginsStore.getState().load();
    await usePluginsStore.getState().setEnabled("com.example.git-lens", false);
    expect(api.disable).toHaveBeenCalledWith("com.example.git-lens");
    expect(usePluginsStore.getState().views?.[0]?.enabled).toBe(false);
  });

  it("失败时写 error 并清掉 busyId，**但保留原列表**", async () => {
    stubApi({
      disable: vi.fn(async () => {
        throw new Error("停用失败：主进程报错了");
      }),
    });
    await usePluginsStore.getState().load();
    const before = usePluginsStore.getState().views;

    await usePluginsStore.getState().setEnabled("com.example.git-lens", false);

    const state = usePluginsStore.getState();
    expect(state.error).toContain("主进程报错了");
    expect(state.busyId).toBeNull();
    // 关键：失败不清空 —— 用户还在看的那份列表不该因为一次失败的操作而消失
    expect(state.views).toBe(before);
  });

  it("操作期间 busyId 指向那一行（行内转圈）", () => {
    let release: (() => void) | undefined;
    stubApi({
      disable: vi.fn(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ views: [], diagnostics: [] });
          }),
      ),
    });
    const pending = usePluginsStore.getState().setEnabled("com.example.git-lens", false);
    expect(usePluginsStore.getState().busyId).toBe("com.example.git-lens");
    release?.();
    return pending;
  });
});

describe("install", () => {
  it("用户取消时不动列表", async () => {
    stubApi({
      install: vi.fn(async () => ({ canceled: true, views: [], diagnostics: [] })),
    });
    await usePluginsStore.getState().load();
    const before = usePluginsStore.getState().views;

    await usePluginsStore.getState().install();

    // 取消 = 他什么都没做，列表不该被清空
    expect(usePluginsStore.getState().views).toBe(before);
  });

  it("成功时用返回的列表替换", async () => {
    stubApi({
      install: vi.fn(async () => ({
        canceled: false,
        views: [viewFixture({ id: "new.plugin" })],
        diagnostics: [],
      })),
    });
    await usePluginsStore.getState().load();
    await usePluginsStore.getState().install();
    expect(usePluginsStore.getState().views?.[0]?.id).toBe("new.plugin");
  });
});

describe("openSurface", () => {
  it("失败只写 error，**不设 busyId**（副作用型操作不该让按钮转圈）", async () => {
    stubApi({
      openSurface: vi.fn(async () => {
        throw new Error("打开界面失败：主进程报错了");
      }),
    });
    await usePluginsStore.getState().openSurface("com.example.git-lens", "git");
    const state = usePluginsStore.getState();
    expect(state.error).toContain("主进程报错了");
    expect(state.busyId).toBeNull();
  });
});
