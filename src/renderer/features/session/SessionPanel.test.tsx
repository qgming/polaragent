/**
 * 会话面板（内容区顶栏右侧那颗按钮 + 它的浮层）的渲染测试。
 *
 * 盯住四件事：
 * 1. 按钮的出现条件 —— 没有活动会话时不渲染（这些区块全都以「当前会话」为口径）；
 * 2. 浮层里的三块（环境信息 / 产物 / 参考），以及**后台作业不在其中**；
 * 3. 产物 / 参考**仍在浮层内展开收起**（只有点具体某个文件才去右侧栏）；
 * 4. **动态** —— 计数徽标与列表跟着 store 走，不是打开时的快照。
 *
 * **后台作业被删除是本文件最要紧的断言之一**：它与对话流里的作业状态 pill 重复 ——
 * 同一条作业、同一个状态、同一批事件画两遍，而那条 pill 就在用户正看的那条命令旁边。
 * 两处画同一件事时，用户要先猜该看哪个，其中一处还得先点开再找。
 *
 * **产物 / 参考仍在浮层里**（本次没有搬去右侧栏）：这一块回答的是「这次会话动过哪些文件」，
 * 一个只需要扫一眼的清单，展开/收起与「环境信息」是同一种阅读节奏。
 * 唯一进右侧栏的是**具体某个文件**（点一行 → 右侧栏打开它）。
 *
 * **任务清单不在这里**：它回到了输入框上方的停靠区（见 ComposerDock.tsx）。
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage } from "@/shared/contracts/session";
import { SessionPanel } from "./SessionPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

/** 一条助手消息，带若干工具调用（用来造出「产物 / 参考」的足迹） */
function assistantWith(calls: { toolName: string; path: string }[]): ChatMessage {
  return {
    id: `m-${calls.map((c) => c.path).join("-")}`,
    entryId: "e1",
    parentId: null,
    role: "assistant",
    createdAt: Date.now(),
    status: "complete",
    parts: calls.map((call, index) => ({
      type: "tool-call" as const,
      toolCallId: `call-${index}`,
      toolName: call.toolName,
      argsText: JSON.stringify({ path: call.path }),
      args: { path: call.path },
      status: "done" as const,
    })),
  };
}

beforeEach(() => {
  useChatStore.setState({
    activeSessionId: null,
    sessions: [{ id: "s1", cwd: "D:/proj", title: "t", createdAt: 0, updatedAt: 0 } as never],
    messagesBySession: {},
    jobsBySession: {},
  });
  useUiStore.setState({ rightPanelOpen: false, rightPanelTabs: [], activeTabId: null });
});

const trigger = () => screen.queryByRole("button", { name: "会话面板" });
const badge = (slot: string) =>
  document.querySelector(`[data-slot="${slot}"]`)?.textContent ?? null;

/** 打开浮层 */
async function open() {
  fireEvent.click(trigger() as HTMLElement);
  // 浮层里的标题是渲染完成的信号
  await screen.findByText("环境信息");
}

describe("SessionPanel", () => {
  it("没有活动会话时不渲染按钮", () => {
    render(<SessionPanel />);
    expect(trigger()).toBeNull();
  });

  it("打开浮层：三块标题都在，且没有任务清单", async () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<SessionPanel />);

    expect(trigger()).not.toBeNull();
    await open();

    for (const title of ["环境信息", "产物", "参考"]) {
      expect(screen.getByText(title)).toBeTruthy();
    }

    // 任务清单已经迁到输入框上方的停靠区：浮层里不该再有第二份
    expect(screen.queryByText("任务清单")).toBeNull();
  });

  /**
   * 本次改动：后台作业那一块**删除**。
   *
   * 它与对话流里的作业状态 pill 是同一份数据（同一个 jobsBySession、同一批 job-changed
   * 事件）画出的同一件事，而 pill 就在那条命令旁边。浮层里再来一份，用户要先猜该看哪个。
   */
  it("后台作业不在浮层里（对话流已有状态 pill，这里是重复）", async () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<SessionPanel />);
    await open();

    expect(screen.queryByText("后台作业")).toBeNull();
    // 连它的折叠触发器与徽标也不该存在
    expect(screen.queryByRole("button", { name: "展开或收起后台作业" })).toBeNull();
    expect(badge("job-count")).toBeNull();
  });

  it("产物在浮层内展开收起，列出文件并给出计数", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: { s1: [assistantWith([{ toolName: "write", path: "src/a.ts" }])] },
    });
    render(<SessionPanel />);
    await open();

    // 徽标在收起态就可见
    expect(badge("artifacts-count")).toBe("1");
    // 内容默认收起：不在 DOM 里
    expect(screen.queryByText("src/a.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开或收起产物" }));
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("参考在浮层内展开收起，列出读过的文件", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: { s1: [assistantWith([{ toolName: "read", path: "src/b.ts" }])] },
    });
    render(<SessionPanel />);
    await open();

    expect(badge("references-count")).toBe("1");
    expect(screen.queryByText("src/b.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开或收起参考" }));
    expect(screen.getByText("src/b.ts")).toBeTruthy();
  });

  /**
   * 点**具体某个文件**才去右侧栏 —— 这是「清单留在原地、内容去宽处看」的分界点。
   * 相对路径要先拼上会话 cwd（工具参数里常常是 `src/a.ts`），否则查看器会被主进程拒。
   */
  it("点文件行：在右侧栏的文件查看器里打开它（相对路径按会话 cwd 拼绝对）", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: { s1: [assistantWith([{ toolName: "write", path: "src/a.ts" }])] },
    });
    render(<SessionPanel />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "展开或收起产物" }));

    fireEvent.click(screen.getByRole("button", { name: "在右侧栏打开 src/a.ts" }));

    const ui = useUiStore.getState();
    expect(ui.rightPanelOpen).toBe(true);
    expect(ui.filePanelTarget).toBe("D:/proj/src/a.ts");
    expect(ui.rightPanelTabs.map((tab) => tab.view)).toContain("file");
  });

  it("没有内容时不给计数徽标（空态不需要摆一个 0）", async () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<SessionPanel />);
    await open();

    expect(badge("artifacts-count")).toBeNull();
    expect(badge("references-count")).toBeNull();
  });

  it("计数跟着 store 实时变，不是打开时的快照", async () => {
    useChatStore.setState({ activeSessionId: "s1" });
    render(<SessionPanel />);
    await open();
    expect(badge("artifacts-count")).toBeNull();

    await act(async () => {
      useChatStore.setState({
        messagesBySession: {
          s1: [assistantWith([{ toolName: "edit", path: "src/c.ts" }])],
        },
      });
    });

    expect(badge("artifacts-count")).toBe("1");
  });

  it("切换会话立刻换成另一个会话的口径", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: {
        s1: [assistantWith([{ toolName: "write", path: "src/a.ts" }])],
        s2: [],
      },
    });
    render(<SessionPanel />);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "展开或收起产物" }));
    expect(badge("artifacts-count")).toBe("1");
    expect(screen.getByText("src/a.ts")).toBeTruthy();

    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });

    // s2 没有产物：徽标不渲染，空态文案出现
    expect(badge("artifacts-count")).toBeNull();
    expect(screen.getByText("本次会话还没有产物")).toBeTruthy();
    expect(trigger()).not.toBeNull();
  });
});
