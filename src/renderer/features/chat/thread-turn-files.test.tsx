/**
 * 「本轮文件改动」在**真实 Thread 里**的接线测试（ui project / jsdom）。
 *
 * 为什么还要这一层：TurnFiles.test.tsx 直接渲染组件、喂手工造的 summary，
 * 它证明不了「这一块到底挂上去了没有」。而这一块的挂载点是 Thread 里那句
 * `turnFilesByMessage.get(message.id)`，它依赖四件事同时对上：
 *   1. 回合边界（用户消息）算得对；
 *   2. store 里的消息经 message-converter 转成 assistant-ui 线程消息后 id 不变
 *      （`message.id` 与 `turnFileSummaries` 的键必须是同一套 id）；
 *   3. 键落在**回合最后一条**消息上，且渲染时那个 id 确实出现过；
 *   4. sessionCwd 取到了会话的工作目录，相对路径能拼成绝对路径。
 *
 * 任何一条错位，表现都是「功能好像没生效」——没有报错、没有异常，只是块不出现。
 * 这类缺陷只能靠走真实链路的断言抓到，所以这里从 store 灌消息、渲染真 ThreadView，
 * 再断言界面上有没有那一块。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage, ChatPart, SessionSummary } from "@/shared/contracts";
import { ThreadView } from "./Thread";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const CWD = "D:/dev/project";

/** provider 会订阅主进程事件流；onEvent 必须返回取消订阅函数，否则卸载时 TypeError */
function stubBridge() {
  vi.stubGlobal("oint", {
    chat: { onEvent: () => () => {} },
    subagents: { onEvent: () => () => {}, runs: async () => [] },
    files: {
      readFile: async (request: { path: string }) => ({
        path: request.path,
        text: "# hi",
        truncated: false,
        size: 4,
        binary: false,
      }),
    },
  });
}

/**
 * 一条会话索引。`cwd` 是必填字段，所以「没有工作目录」这个场景用空串表达 ——
 * Thread 取值时 sessionCwd 会拿到空串，toAbsolutePath 对它退回原始相对路径
 *（与「字段缺省」走的是同一个分支，见 turn-files 的 toAbsolutePath）。
 */
function session(cwd: string): SessionSummary {
  return {
    id: "s1",
    title: "测试会话",
    createdAt: 0,
    updatedAt: 0,
    cwd,
    archived: false,
    pinned: false,
    messageCount: 2,
    model: null,
  };
}

function userMessage(id: string): ChatMessage {
  return {
    id,
    role: "user",
    createdAt: 0,
    parts: [{ type: "text", text: "帮我写点东西" }],
    status: "complete",
  };
}

function assistantMessage(id: string, calls: { toolName: string; path: string }[]): ChatMessage {
  const parts = calls.map(
    (call, index): ChatPart => ({
      type: "tool-call",
      toolCallId: `${id}-${index}`,
      toolName: call.toolName,
      argsText: "{}",
      args: { path: call.path },
      status: "done",
    }),
  );
  return { id, role: "assistant", createdAt: 0, parts, status: "complete" };
}

/** 把消息与会话灌进 store，再渲染真 ThreadView */
function renderThread(messages: ChatMessage[], cwd: string, running = false) {
  stubBridge();
  useChatStore.setState({
    activeSessionId: "s1",
    sessions: [session(cwd)],
    messagesBySession: { s1: messages },
    // 主进程 run-started / run-ended 写的权威信号（见 turn-files 的说明）
    runningBySession: running ? { s1: true } : {},
  });
  return render(
    <OintRuntimeProvider>
      <ThreadView />
    </OintRuntimeProvider>,
  );
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: [], messagesBySession: {} });
  useUiStore.setState({ rightPanelTabs: [], activeTabId: null, filePanelTarget: null });
});

describe("本轮文件改动在真实 Thread 里", () => {
  /**
   * **这是用户报的那个「中途闪一下」的回归点。**
   *
   * 多步 run 的步骤与步骤之间，「没有工具在跑」恰好成立 —— 旧判据于是让块在那一刻冒出来，
   * 下一步的工具一起来又消失。现在判据是**整轮结束**（store 的 runningBySession），
   * 跑动中整块按住不出。
   *
   * 断言口径取「界面上有没有这一块」，而不是 turnFileSummaries 的返回值：那个纯函数
   * 已经由 turn-files.test.ts 覆盖，这里要证明的是**它真的接到了运行状态上** ——
   * 接线断了的话纯函数照样全绿。
   */
  it("整轮还在跑时不出块（哪怕这一轮的工具都已经完成）", () => {
    renderThread(
      [
        userMessage("u1"),
        // 工具都 done、消息也不是 streaming：正是旧判据会误判为「跑完了」的形态
        assistantMessage("a1", [{ toolName: "write", path: "docs/guide.md" }]),
      ],
      CWD,
      true,
    );

    expect(screen.queryByText("本轮文件改动")).toBeNull();
    expect(screen.queryByLabelText("打开 guide.md")).toBeNull();
  });

  it("整轮结束后才出现这一块", () => {
    const messages = [
      userMessage("u1"),
      assistantMessage("a1", [{ toolName: "write", path: "docs/guide.md" }]),
    ];

    // 跑动中：没有
    const running = renderThread(messages, CWD, true);
    expect(screen.queryByText("本轮文件改动")).toBeNull();
    running.unmount();

    // 运行结束：出现（同一个消息数组，只换了运行状态）
    renderThread(messages, CWD, false);
    expect(screen.getByText("本轮文件改动")).toBeTruthy();
    expect(screen.getByLabelText("打开 guide.md")).toBeTruthy();
  });

  it("回合结束后出现这一块，代码文件只出 chip、markdown 出卡片", () => {
    renderThread(
      [
        userMessage("u1"),
        assistantMessage("a1", [
          { toolName: "write", path: "src/a.ts" },
          { toolName: "write", path: "docs/guide.md" },
        ]),
      ],
      CWD,
    );

    expect(screen.getByText("本轮文件改动")).toBeTruthy();
    // 卡片只有 markdown 那一张
    expect(screen.getByLabelText("打开 guide.md")).toBeTruthy();
    expect(screen.queryByLabelText("打开 a.ts")).toBeNull();
    // 代码文件仍以 chip 出现
    expect(screen.getByText("a.ts")).toBeTruthy();
  });

  it("点卡片把绝对路径写进 store（相对路径拼上了会话 cwd）", () => {
    renderThread(
      [userMessage("u1"), assistantMessage("a1", [{ toolName: "write", path: "docs/guide.md" }])],
      CWD,
    );

    fireEvent.click(screen.getByLabelText("打开 guide.md"));

    expect(useUiStore.getState().filePanelTarget).toBe(`${CWD}/docs/guide.md`);
  });

  it("一次回复被工具切成多条助手消息时，整块只出现一次（挂在回合末尾）", () => {
    renderThread(
      [
        userMessage("u1"),
        assistantMessage("a1", [{ toolName: "write", path: "one.md" }]),
        assistantMessage("a2", [{ toolName: "edit", path: "two.md" }]),
      ],
      CWD,
    );

    // 与 MessageRail 的 groupRuns 同一口径：相邻助手消息属于同一次运行，只出一块
    expect(screen.getAllByText("本轮文件改动")).toHaveLength(1);
    // 两个文件各出现两次（chip + 卡片），按「至少一个」断言
    expect(screen.getAllByText("one.md").length).toBeGreaterThan(0);
    expect(screen.getAllByText("two.md").length).toBeGreaterThan(0);
  });

  it("两个回合各自出自己那一块", () => {
    renderThread(
      [
        userMessage("u1"),
        assistantMessage("a1", [{ toolName: "write", path: "one.md" }]),
        userMessage("u2"),
        assistantMessage("a2", [{ toolName: "write", path: "two.md" }]),
      ],
      CWD,
    );

    expect(screen.getAllByText("本轮文件改动")).toHaveLength(2);
  });

  it("只读了文件、没改任何东西的回合不出这一块", () => {
    renderThread(
      [
        userMessage("u1"),
        // read 不是写类工具：这一块说的是「改了什么」，不是「碰过什么」
        assistantMessage("a1", [{ toolName: "read", path: "untouched.md" }]),
      ],
      CWD,
    );

    expect(screen.queryByText("本轮文件改动")).toBeNull();
  });

  it("会话没有绑定 cwd（空串）时仍然显示（展示与打开是两件事）", () => {
    renderThread(
      [userMessage("u1"), assistantMessage("a1", [{ toolName: "write", path: "docs/guide.md" }])],
      "",
    );

    expect(screen.getByText("本轮文件改动")).toBeTruthy();
    expect(screen.getByLabelText("打开 guide.md")).toBeTruthy();
  });
});
