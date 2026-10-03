import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/renderer/components/ui/tooltip";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";
import { QueueDock } from "./ComposerDock";
import { EditMessageDialog } from "./EditMessageDialog";

const queued = { id: "q1", text: "原来的消息", mode: "followUp" as const };
const editQueued = vi.fn(async () => true);
const sendQueued = vi.fn(async () => true);

function Fixture() {
  const queue = useChatStore((s) => s.queueBySession.s1 ?? []);
  return (
    <TooltipProvider>
      <QueueDock items={queue} />
      <EditMessageDialog />
    </TooltipProvider>
  );
}

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  editQueued.mockReset().mockResolvedValue(true);
  sendQueued.mockReset().mockResolvedValue(true);
  vi.stubGlobal("oint", { chat: { editQueued, sendQueued } });
  useUiStore.getState().closeEditMessage();
  useChatStore.setState({
    activeSessionId: "s1",
    messagesBySession: { s1: [] },
    queueBySession: { s1: [queued] },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.getState().closeEditMessage();
});

function openEditor() {
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  return screen.getByRole("textbox", { name: "编辑消息" });
}

describe("queued message actions", () => {
  it("still opens history messages with the resend action and discarded-reply warning", () => {
    useChatStore.setState({
      messagesBySession: {
        s1: [
          {
            id: "entry:1",
            entryId: "entry:1",
            role: "user",
            createdAt: 1,
            parts: [{ type: "text", text: "历史消息" }],
            status: "complete",
          },
          {
            id: "entry:2",
            entryId: "entry:2",
            role: "assistant",
            createdAt: 2,
            parts: [{ type: "text", text: "历史回复" }],
            status: "complete",
          },
        ],
      },
    });
    useUiStore.getState().beginEditMessage("entry:1");
    render(<Fixture />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("历史消息");
    expect(screen.getByRole("button", { name: "发送" })).toBeTruthy();
    expect(screen.getByText(/它之后的回复会被丢弃/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("opens the shared editor and saves to the same queue item without sending", async () => {
    const input = openEditor();
    expect((input as HTMLTextAreaElement).value).toBe(queued.text);
    expect(screen.queryByText(/回复会被丢弃/)).toBeNull();
    fireEvent.change(input, { target: { value: "修改后的消息" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editQueued).toHaveBeenCalledWith("s1", "q1", "修改后的消息");
    expect(sendQueued).not.toHaveBeenCalled();
  });

  it("preserves the draft across queue updates and cancels without mutation", () => {
    const input = openEditor();
    fireEvent.change(input, { target: { value: "未保存草稿" } });
    act(() =>
      useChatStore.setState({
        queueBySession: { s1: [{ ...queued }] },
        messagesBySession: { s1: [] },
      }),
    );
    expect((input as HTMLTextAreaElement).value).toBe("未保存草稿");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(editQueued).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(queued.text);
  });

  it("rejects blank input and ignores Enter during IME composition or with Shift", () => {
    const input = openEditor();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    expect(editQueued).not.toHaveBeenCalled();
  });

  it("keeps the draft on failure and lets Enter retry", async () => {
    editQueued.mockRejectedValueOnce(new Error("offline"));
    const input = openEditor();
    fireEvent.change(input, { target: { value: "需要保存" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("alert");
    expect((input as HTMLTextAreaElement).value).toBe("需要保存");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(editQueued).toHaveBeenCalledTimes(2);
  });

  it.each(["session", "consumed"])("closes when the target changes: %s", (change) => {
    openEditor();
    act(() =>
      useChatStore.setState(
        change === "session" ? { activeSessionId: "s2" } : { queueBySession: { s1: [] } },
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(editQueued).not.toHaveBeenCalled();
  });

  it("locks send/edit/remove while sending and exposes a retry after failure", async () => {
    let reject = (_error: Error) => {};
    sendQueued.mockImplementationOnce(
      () =>
        new Promise<boolean>((_resolve, fail) => {
          reject = fail;
        }),
    );
    render(<Fixture />);
    const send = screen.getByRole("button", { name: "立即发送" });
    fireEvent.click(send);
    fireEvent.click(send);
    expect(sendQueued).toHaveBeenCalledTimes(1);
    expect(sendQueued).toHaveBeenCalledWith("s1", "q1");
    for (const name of ["立即发送", "编辑", "移除"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    await act(async () => reject(new Error("offline")));
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(send);
    await waitFor(() => expect(sendQueued).toHaveBeenCalledTimes(2));
  });
});
