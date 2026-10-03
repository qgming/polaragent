import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatLiveSnapshot, ChatRetryState } from "@/shared/contracts/chat";
import type { ChatMessage } from "@/shared/contracts/session";
import { ThreadView } from "./Thread";

const generationId = "1:17";
const error = "Request timed out.\nUpstream returned 503.\nDiagnostic detail on the final line.";
const retrying: ChatRetryState = {
  generationId,
  phase: "retrying",
  attempt: 2,
  maxAttempts: 5,
  error,
};
const user: ChatMessage = {
  id: "u1",
  role: "user",
  createdAt: 0,
  parts: [{ type: "text", text: "继续处理" }],
  status: "complete",
};
const failures = [1, 2, 3].map(
  (n): ChatMessage => ({
    id: `a${n}`,
    role: "assistant",
    generationId,
    createdAt: n,
    parts: [],
    status: "error",
    error: n === 3 ? error : `Failure ${n}`,
  }),
);

function seed(retry: ChatRetryState | null, messages = [user, ...failures], sessionId = "s1") {
  const snapshot: ChatLiveSnapshot = {
    generation: 1,
    revision: 1,
    state: {
      conversationId: 1,
      messages,
      reports: {},
      admittedRequestIds: [],
      running: retry?.phase === "retrying",
      runId: retry?.phase === "retrying" ? "17" : null,
      queue: [],
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      compaction: null,
      retry,
    },
  };
  useChatStore.setState({
    activeSessionId: sessionId,
    sessions: [
      {
        id: sessionId,
        title: "Retry",
        createdAt: 0,
        updatedAt: 0,
        cwd: "D:/project",
        archived: false,
        pinned: false,
        messageCount: messages.length,
        model: null,
      },
    ],
    messagesBySession: { [sessionId]: messages },
    viewsBySession: { [sessionId]: snapshot },
    runningBySession: { [sessionId]: snapshot.state.running },
    sessionLoadErrors: {},
    loadingFirstBySession: {},
    loadingOlderBySession: {},
    queueBySession: {},
    pendingApprovals: [],
    pendingAsks: [],
    compactions: {},
  });
}

function mount() {
  return render(
    <TooltipProvider>
      <OintRuntimeProvider>
        <ThreadView />
      </OintRuntimeProvider>
    </TooltipProvider>,
  );
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});
beforeEach(() => {
  vi.stubGlobal("oint", {
    chat: { onEvent: () => () => {} },
    subagents: { onEvent: () => () => {}, runs: async () => [] },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("request retry feedback in the thread", () => {
  it("shows one compact retry row, expands full diagnostics and keeps details open across retries", () => {
    seed(retrying);
    mount();
    const trigger = screen.getByRole("button", { name: "正在重新连接 2/5" });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "请求失败" })).toBeNull();
    expect(screen.queryByText(error)).toBeNull();
    expect(document.querySelectorAll("[data-message-id][hidden]")).toHaveLength(3);
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(trigger.getAttribute("aria-controls") ?? "")?.textContent).toBe(
      error,
    );
    act(() => seed({ ...retrying, attempt: 3, error: `${error}\nNew attempt failed` }));
    expect(
      screen.getByRole("button", { name: "正在重新连接 3/5" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.getByText(/New attempt failed/)).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a single full red error card in the footer only after exhaustion", () => {
    seed(retrying);
    mount();
    act(() => seed({ ...retrying, phase: "failed", attempt: 5 }));
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("重新连接失败，已重试 5 次")).toBeDefined();
    expect(alert.querySelector("pre")?.textContent).toBe(error);
    expect(alert.closest('[data-slot="aui_thread-viewport-footer"]')).not.toBeNull();
    expect(screen.queryByRole("button", { name: /正在重新连接/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "请求失败" })).toBeNull();
  });

  it("shows permanent configuration errors immediately without claiming five retries", () => {
    seed({ ...retrying, phase: "failed", attempt: 0, error: "401 Invalid API key" });
    mount();
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("请求失败")).toBeDefined();
    expect(alert.textContent).toContain("401 Invalid API key");
    expect(alert.textContent).not.toContain("重试");
  });

  it("clears active feedback on success or cancellation and resets expansion between sessions", () => {
    seed(retrying);
    mount();
    fireEvent.click(screen.getByRole("button", { name: "正在重新连接 2/5" }));
    act(() => seed({ ...retrying, generationId: "2:18", attempt: 1 }, [user], "s2"));
    expect(
      screen.getByRole("button", { name: "正在重新连接 1/5" }).getAttribute("aria-expanded"),
    ).toBe("false");
    act(() => seed(null));
    expect(screen.queryByRole("button", { name: /正在重新连接/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    act(() =>
      seed(null, [
        user,
        ...failures,
        {
          id: "success",
          role: "assistant",
          generationId,
          createdAt: 4,
          parts: [{ type: "text", text: "连接已恢复" }],
          status: "complete",
        },
      ]),
    );
    expect(screen.getByText("连接已恢复")).toBeDefined();
    expect(screen.queryByRole("button", { name: "请求失败" })).toBeNull();
  });

  it("keeps partial output and one expandable historical error per request", () => {
    const partial: ChatMessage = {
      ...failures[0],
      id: "partial",
      role: "assistant",
      generationId,
      createdAt: 1,
      parts: [{ type: "text", text: "已生成的部分结果" }],
      status: "error",
      error: "First failure",
    };
    seed(null, [user, partial, ...failures.slice(1)]);
    mount();
    expect(screen.getByText("已生成的部分结果")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "请求失败" })).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "请求失败" }));
    expect(screen.getByText(/Diagnostic detail on the final line/)).toBeDefined();
  });
});
