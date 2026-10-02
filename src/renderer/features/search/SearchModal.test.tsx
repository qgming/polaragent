import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { SearchModal } from "./SearchModal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  useUiStore.setState({ searchOpen: true });
  useChatStore.setState({
    sessions: [
      {
        id: "s1",
        title: "目标会话",
        createdAt: 0,
        updatedAt: 0,
        cwd: "",
        archived: false,
        pinned: false,
        messageCount: 1,
        model: null,
      },
    ],
    messagesBySession: {},
    runningBySession: {},
  });
});
describe("search selection", () => {
  it("keeps search open until the selected session finishes loading", async () => {
    let finish!: () => void;
    vi.spyOn(useChatStore.getState(), "setActiveSession").mockImplementation(async (id) => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      useChatStore.setState({ activeSessionId: id });
    });
    render(<SearchModal />);
    fireEvent.click(screen.getByText("目标会话"));
    expect(useUiStore.getState().searchOpen).toBe(true);
    await act(async () => {
      finish();
    });
    await waitFor(() => expect(useUiStore.getState().searchOpen).toBe(false));
  });
  it("keeps results available and explains a failed selection", async () => {
    vi.spyOn(useChatStore.getState(), "setActiveSession").mockRejectedValue(new Error("offline"));
    render(<SearchModal />);
    fireEvent.click(screen.getByText("目标会话"));
    await screen.findByText("会话加载失败，请重试");
    expect(useUiStore.getState().searchOpen).toBe(true);
  });
});
