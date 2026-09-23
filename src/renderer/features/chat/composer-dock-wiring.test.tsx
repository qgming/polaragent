/**
 * 停靠区与 Composer 的接线测试。
 *
 * 单独一个文件、且**渲染真的 Composer**，是因为「停靠区挂在输入框上方」这件事本身
 * 没有类型信号：组件写好了、测试也过了，但只要忘了在 Composer 里渲染它，用户就永远看不到 ——
 * 而那种失败在组件单测里完全测不出来（它们直接渲染 dock）。
 *
 * 这里还要钉住一条位置约定：停靠区必须在 **ComposerPrimitive.Root 之外**、且在其**之前**。
 * 放进 Root 内部会与外层的 24px 圆角打架（内层方角从圆角里露出来）。
 */

import { AssistantRuntimeProvider, useExternalStoreRuntime } from "@assistant-ui/react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { toThreadMessage } from "@/renderer/runtime/message-converter";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { ChatMessage, ChatPart } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { Composer } from "./Composer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const EMPTY_MESSAGES: ChatMessage[] = [];

beforeEach(() => {
  vi.stubGlobal("oint", {
    chat: {
      onEvent: () => () => {},
      queue: vi.fn(async () => undefined),
      cancelQueued: vi.fn(async () => undefined),
    },
    prompts: { list: vi.fn(async () => []) },
    subagents: { onEvent: () => () => {}, runs: async () => [] },
  });
  /**
   * Composer 会读 settings 里的模型/模式/思考档位，缺了它 resolveEffectiveModelRef
   * 会在 `settings.defaultModel` 上直接抛。这里给一份最小可用的设置。
   */
  useSettingsStore.setState({
    settings: {
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
    } satisfies Settings,
    loaded: true,
  });
  useChatStore.setState({
    activeSessionId: "s1",
    sessions: [],
    messagesBySession: {},
    queueBySession: {},
    runningBySession: {},
  });
});

/** 一条带 todo 工具调用的助手消息 */
function todoMessage(): ChatMessage {
  const todos = [
    { id: "1", text: "读代码", status: "done" },
    { id: "2", text: "改实现", status: "active" },
  ];
  const part: ChatPart = {
    type: "tool-call",
    toolCallId: "call-1",
    toolName: "todo",
    argsText: "{}",
    args: { todos },
    details: { todos },
    status: "done",
  };
  return { id: "a1", role: "assistant", createdAt: 0, parts: [part], status: "complete" };
}

/** 最小运行时外壳：只用 Composer 真正依赖的那些能力（与同目录其它 Composer 测试一致） */
function Harness() {
  const runtime = useExternalStoreRuntime<ChatMessage>({
    messages: EMPTY_MESSAGES,
    isRunning: false,
    convertMessage: toThreadMessage,
    onNew: async () => {},
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <Composer />
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

function renderComposer() {
  return render(<Harness />);
}

describe("停靠区在 Composer 里的接线", () => {
  it("有任务清单时，输入框上方出现任务清单", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: { s1: [todoMessage()] },
    });

    renderComposer();

    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("没有清单时输入框上方是干净的（不留空壳）", () => {
    renderComposer();
    expect(screen.queryByText("任务清单")).toBeNull();
  });

  it("有排队消息时出现队列块，且能折叠", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      queueBySession: {
        s1: [
          { id: "q1", text: "甲", mode: "followUp" },
          { id: "q2", text: "乙", mode: "followUp" },
        ],
      },
    });

    renderComposer();

    expect(screen.getByText("2 条待发送")).toBeTruthy();
    fireEvent.click(screen.getByText("2 条待发送"));
    expect(screen.queryByText("甲")).toBeNull();
  });

  it("停靠区在输入框之前（DOM 顺序 = 视觉上的上方）", () => {
    useChatStore.setState({
      activeSessionId: "s1",
      messagesBySession: { s1: [todoMessage()] },
    });

    const { container } = renderComposer();
    const dock = container.querySelector('[data-slot="composer-dock-todo"]');
    const input = container.querySelector("textarea");

    expect(dock).not.toBeNull();
    expect(input).not.toBeNull();
    // compareDocumentPosition：dock 在 input 之前（FOLLOWING = input 在 dock 之后）
    const relation = dock?.compareDocumentPosition(input as Node) ?? 0;
    expect(relation & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
