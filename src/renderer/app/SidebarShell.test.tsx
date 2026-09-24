/**
 * 侧栏底部那一排入口的接线测试（ui project / jsdom）。
 *
 * 为什么专门测「按钮 → store」这一步：侧栏这一排是**唯一**的数据统计入口，
 * 而它接错线不会有任何东西变红 —— 按钮画得出来、点下去没反应，
 * 单测与类型检查都不会发现（本仓过去就吃过这个亏）。
 *
 * 只替换官方 thread-list 那几个原语：它们要 runtime 上下文，而这条用例关心的是
 * 底部那一排（会话列表本身有它自己的覆盖，见 OintRuntimeProvider 相关用例）。
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { useUiStore } from "@/renderer/stores/ui-store";
import { SidebarShell } from "./SidebarShell";

/** 与 App 一样套一层 TooltipProvider：侧栏那一排按钮各自带 tooltip */
function renderSidebar() {
  return render(
    <TooltipProvider>
      <SidebarShell />
    </TooltipProvider>,
  );
}

vi.mock("@/renderer/components/assistant-ui/elements/thread-list.aui", () => ({
  ThreadListRoot: ({ children, ...props }: { children?: React.ReactNode }) => (
    <div {...props}>{children}</div>
  ),
  ThreadListNew: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
  ThreadListItems: () => <div data-slot="thread-items" />,
}));

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useUiStore.setState({
    sidebarCollapsed: false,
    searchOpen: false,
    settingsOpen: false,
    pluginsOpen: false,
    statsOpen: false,
    pluginModal: null,
    pendingDeleteSessionId: null,
  });
});

describe("侧栏底部入口", () => {
  it("插件、数据统计、主题三者从左到右依次相邻（统计就在插件与主题之间）", () => {
    renderSidebar();

    const plugins = screen.getByRole("button", { name: "插件" });
    const stats = screen.getByRole("button", { name: "数据统计" });
    const row = plugins.parentElement;
    expect(row).toBe(stats.parentElement);

    const siblings = [...(row?.children ?? [])];
    // 一行三项：插件 → 数据统计 → 主题（统计恰在两者之间）
    expect(siblings).toHaveLength(3);
    expect(siblings.indexOf(plugins)).toBe(0);
    expect(siblings.indexOf(stats)).toBe(1);
    // 末项是主题开关：它的可访问名是当前主题（浅色 / 深色 / 跟随系统）。
    // 触发器可能就是按钮本身，也可能被 tooltip 包了一层，两种形状都认。
    const theme = siblings[2];
    const themeLabel =
      theme?.getAttribute("aria-label") ??
      theme?.querySelector("[aria-label]")?.getAttribute("aria-label");
    expect(themeLabel ?? "").toMatch(/浅色|深色|跟随系统/);
  });

  it("点数据统计打开统计模态窗", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "数据统计" }));

    expect(useUiStore.getState().statsOpen).toBe(true);
  });

  it("点插件打开的是插件模态窗（两个入口没有接串）", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "插件" }));

    expect(useUiStore.getState().pluginsOpen).toBe(true);
    expect(useUiStore.getState().statsOpen).toBe(false);
  });

  it("统计入口带右侧 tooltip 文案（与外层那排一致）", () => {
    renderSidebar();
    const stats = screen.getByRole("button", { name: "数据统计" });
    expect(stats.getAttribute("aria-label")).toBe("数据统计");
  });
});
