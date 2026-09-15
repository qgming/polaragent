/**
 * Task 系列必须是「独立显示」的工具 UI。
 *
 * 为什么值得单独钉一条断言：这件事**没有类型信号**，也不改变任何组件的渲染结果 ——
 * 它只往 assistant-ui 的运行时注册表里写一个标记，而那个标记决定
 * `MessagePrimitive.GroupedParts` 会不会把这次调用折进「思维链 / 工具时间线」。
 * 漏注册时页面看起来完全正常：模型在同一条消息里同时发了 grep 和 Task 时，
 * Task 被折进那条折叠轨迹，子智能体的 pill 只在展开某一步之后才出现 ——
 * 也就是「看起来还是个普通工具」，而这正是要改掉的样子。
 *
 * 断言口径取注册表本身（`tools.toolUIs`）而不是渲染结果：折叠与否是库根据注册表算出来的，
 * 钉住注册表就等于钉住了「会不会被折进去」；反过来从 DOM 反推需要构造一整条消息与
 * 分组树，测出失败时也说不清是注册丢了还是分组规则变了。
 */

import { useAuiState } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  // provider 会订阅主进程的聊天事件流：onEvent 必须返回取消订阅函数，否则卸载时 TypeError
  vi.stubGlobal("oint", {
    chat: {
      onEvent: () => () => {},
    },
  });
  useChatStore.setState({ sessions: [], activeSessionId: null, messagesBySession: {} });
});

/** 把运行时注册表读成「工具名 → 是否独立显示」，便于直接断言 */
function ToolRegistryProbe(): React.JSX.Element {
  const registry = useAuiState((state) => state.tools.toolUIs);
  const rendered = Object.entries(registry)
    .map(
      ([name, entries]) => `${name}:${entries[0]?.standalone === true ? "standalone" : "inline"}`,
    )
    .join(",");
  return <output data-testid="registry">{rendered}</output>;
}

function registryText(): string {
  return screen.getByTestId("registry").textContent ?? "";
}

describe("子智能体工具的显示方式", () => {
  it("Task 四件套注册成 standalone，别的工具不受影响", () => {
    render(
      <OintRuntimeProvider>
        <ToolRegistryProbe />
      </OintRuntimeProvider>,
    );

    const text = registryText();
    for (const toolName of ["Task", "TaskWait", "TaskList", "TaskStop"]) {
      expect(text).toContain(`${toolName}:standalone`);
    }
    // 其余工具不该被顺手注册成独立显示：普通工具仍然走思维链折叠，这是主会话的阅读节奏
    for (const toolName of ["bash", "read", "edit", "grep", "glob"]) {
      expect(text).not.toContain(`${toolName}:standalone`);
    }
  });

  /**
   * 作业四件套同一件事：它们也必须是独立的一块。
   * 漏注册时「跑完没有」会连同别的工具一起被折进轨迹里 —— 而作业的整个意义就是
   * 「这条命令还在不在跑」，折起来等于把这个判断藏掉。
   */
  it("作业四件套也注册成 standalone", () => {
    render(
      <OintRuntimeProvider>
        <ToolRegistryProbe />
      </OintRuntimeProvider>,
    );

    const text = registryText();
    for (const toolName of ["bash_background", "job_output", "job_list", "job_kill"]) {
      expect(text).toContain(`${toolName}:standalone`);
    }
  });
});
