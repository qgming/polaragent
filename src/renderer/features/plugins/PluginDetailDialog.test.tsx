/**
 * 插件详情弹窗里**两句如实告知**的渲染测试（ui project / jsdom）。
 *
 * 这个弹窗是用户做「装不装 / 信不信」判断的地方，而权限卡上原本有两处**做不到的承诺**：
 *
 *  1. 有一批权限宿主还没有执行点（`fs.*` / `hostHooks.register` …），列出来跟在管的规则
 *     长得一样 —— 现在要打「未生效」；
 *  2. 带代码的插件（有 `main`）跑在独立进程里，那是**崩溃隔离不是沙箱**，
 *     权限表管不住它直接 `require("node:fs")` —— 现在要把这句写在权限表正下方。
 *
 * 两处都只对**该看见的插件**显示：不对声明式插件说第 2 句（它不跑代码），
 * 也不在没有未生效权限时说第 1 句（那是纯噪音）。
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import i18n from "@/renderer/i18n";
import type { PluginPermissionView, PluginView } from "@/shared/contracts/plugin";
import { PluginDetailDialog } from "./PluginDetailDialog";

// vitest 未开 globals，RTL 的自动清理不会注册，必须手动
afterEach(cleanup);

// 断言用中文词条：初始语言跟着 navigator.language 走，测试里不能依赖它
beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

function viewFixture(patch: Partial<PluginView> = {}): PluginView {
  return {
    id: "dev.example.demo",
    name: "示例插件",
    version: "1.0.0",
    description: "说明",
    source: "user",
    removable: true,
    enabled: true,
    state: "running",
    contributions: {
      panels: 0,
      modals: 0,
      windows: 0,
      commands: 0,
      skills: 0,
      prompts: 0,
      subagents: 0,
      mcpServers: 0,
      tools: 0,
    },
    permissions: [],
    newlyRequested: [],
    contributionNames: { skills: [], prompts: [], subagents: [], mcpServers: [] },
    hooks: [],
    hasMain: false,
    surfaces: [],
    ...patch,
  };
}

function permission(id: string, risk: PluginPermissionView["risk"]): PluginPermissionView {
  return { id, risk };
}

describe("PluginDetailDialog", () => {
  it("带代码的插件显示信任边界那句（权限表管的是宿主给的能力，不是它的全部能力）", () => {
    render(
      <PluginDetailDialog
        view={viewFixture({
          hasMain: true,
          permissions: [permission("agent.tool.register", "high")],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/不是系统沙箱/)).toBeTruthy();
  });

  it("声明式插件（没有 main）不显示那句 —— 它不跑代码", () => {
    render(
      <PluginDetailDialog
        view={viewFixture({ hasMain: false, permissions: [permission("ui.panel", "low")] })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText(/不是系统沙箱/)).toBeNull();
  });

  it("没有执行点的权限打「未生效」，并给出一句说明", () => {
    render(
      <PluginDetailDialog
        view={viewFixture({
          permissions: [permission("fs.write", "high"), permission("shell.exec", "high")],
        })}
        onClose={() => {}}
      />,
    );

    // 两枚权限里只有 fs.write 未生效 —— 标记数必须正好是一，而不是"有一条就全标"
    expect(screen.getAllByText("未生效")).toHaveLength(1);
    expect(screen.getByText(/宿主还没有实现对应的执行点/)).toBeTruthy();
  });

  it("全部权限都有执行点时不出现「未生效」与那句说明", () => {
    render(
      <PluginDetailDialog
        view={viewFixture({
          hasMain: true,
          permissions: [permission("shell.exec", "high"), permission("ui.panel", "low")],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText("未生效")).toBeNull();
    expect(screen.queryByText(/宿主还没有实现对应的执行点/)).toBeNull();
  });

  /**
   * **贡献物的名字必须露出来。**
   *
   * 按 §4.8 的边界，插件贡献的技能不进设置面板的技能列表（那三张列表的主语是用户），
   * 于是这里成了唯一能看到它们的地方。只给"技能 2"等于没回答"它给我带来了什么" ——
   * 而那正是用户装一个插件之后最想知道的事。
   */
  it("贡献物不只给个数：把名字列出来，空的类别不占行", () => {
    render(
      <PluginDetailDialog
        view={viewFixture({
          contributions: {
            panels: 0,
            modals: 0,
            windows: 0,
            commands: 0,
            skills: 2,
            prompts: 0,
            subagents: 0,
            mcpServers: 1,
            tools: 0,
          },
          contributionNames: {
            skills: ["review", "translate"],
            prompts: [],
            subagents: [],
            mcpServers: ["github"],
          },
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("技能：review、translate")).toBeTruthy();
    expect(screen.getByText("MCP 服务：github")).toBeTruthy();
    // 空的那两类不渲染标题行（一个只贡献技能的插件不该多两行空标题）
    expect(screen.queryByText(/^魔法提示：/)).toBeNull();
    expect(screen.queryByText(/^子智能体：/)).toBeNull();
  });

  /**
   * **钩子要逐条列出来。**
   *
   * `PreToolUse` 能拦住工具调用 —— 这是插件系统里最需要"用户看见"的一件事，
   * 而它在权限卡上只表现为一句"介入工具调用"。这条用例钉三件事：
   * 事件名、匹配范围（没有 matcher 时写"全部工具"而不是留空）、
   * 以及「出错时拒绝」那枚标记（一个坏钩子会挡住调用，用户该知道）。
   */
  it("钩子：列出事件与匹配范围，fail-closed 的才打标记；没有钩子就不画那一栏", () => {
    const { unmount } = render(
      <PluginDetailDialog
        view={viewFixture({
          hooks: [
            { id: "no-bash-rm", event: "PreToolUse", matcher: "^bash$" },
            { id: "note", event: "PostToolUse" },
            { id: "logger", event: "PreToolUse", failure: "open" },
          ],
        })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("介入点")).toBeTruthy();
    expect(screen.getByText("^bash$")).toBeTruthy();
    // 没有 matcher 的钩子管全部工具 —— 显示"全部工具"，不能留空让人猜（夹具里有两条）
    expect(screen.getAllByText("全部工具")).toHaveLength(2);
    // 三条里只有第一条是 fail-closed 的 PreToolUse；failure: open 那条不该被标
    expect(screen.getAllByText("出错时拒绝")).toHaveLength(1);
    unmount();

    render(<PluginDetailDialog view={viewFixture()} onClose={() => {}} />);
    expect(screen.queryByText("介入点")).toBeNull();
  });
});
