/**
 * 附件从「选文件」到「真的发给主进程」的端到端回归（ui project / jsdom）。
 *
 * ## 这个文件存在的理由
 *
 * 它钉住的是那次**图片从来没有离开过渲染进程**的根因：assistant-ui 把附件放在
 * `AppendMessage.attachments`（与 `content` 并列），而旧代码只扫 `message.content`
 * —— 于是 `images` 恒为 undefined：界面上不显示图片，模型也收不到，
 * 而整条链上**没有任何一处报错**。
 *
 * 所以断言必须落在**最外面那一环**：`window.oint.chat.send` 到底收到了什么。
 * 组件级断言（缩略图画出来了、onNew 被调用了）都挡不住这个 bug —— 缩略图在输入框里
 * 一直画得好好的，onNew 也一直被调用，只是参数里没有附件。
 *
 * 挂的是**真的** OintRuntimeProvider + 真的 Composer + 真的附件适配器，
 * 只把 `window.oint` 这个进程边界与 jsdom 缺的浏览器能力（canvas / createImageBitmap）换掉。
 */

import { useAui } from "@assistant-ui/react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useSettingsStore } from "@/renderer/stores/settings-store";
import type { ChatAttachment } from "@/shared/contracts/attachment";
import type { ChatMessage, SessionSummary } from "@/shared/contracts/session";
import type { Settings } from "@/shared/contracts/settings";
import { DEFAULT_WEB_SEARCH_SETTINGS } from "@/shared/contracts/web";
import { Composer } from "./Composer";

afterEach(cleanup);

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const SESSION: SessionSummary = {
  id: "s1",
  title: "会话",
  createdAt: 0,
  updatedAt: 0,
  cwd: "D:/proj",
  archived: false,
  pinned: false,
  messageCount: 0,
  model: null,
};

/** 1×1 PNG 的裸 base64 */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** jsdom 没有 canvas 与 createImageBitmap：按最小可用形状垫上，让图片分支真的跑起来 */
function installCanvasShims(): void {
  const context = { drawImage: () => {} };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: () => context,
  });
  Object.defineProperty(HTMLCanvasElement.prototype, "toDataURL", {
    configurable: true,
    value: () => `data:image/png;base64,${PNG_B64}`,
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: async () => ({ width: 4000, height: 3000, close: () => {} }),
  });
}

afterAll(() => {
  Reflect.deleteProperty(globalThis, "createImageBitmap");
});

/** `window.oint` 的最小可用替身：只补这条链真的会调到的方法 */
function stubBridge(options: { pathForFile?: string } = {}) {
  const send = vi.fn(async () => {});
  const pathForFile = vi.fn(() => options.pathForFile ?? "");
  vi.stubGlobal("oint", {
    skills: { list: vi.fn(async () => []) },
    prompts: { list: vi.fn(async () => []) },
    chat: { send, onEvent: vi.fn(() => () => {}) },
    files: { pathForFile },
    app: { openPath: vi.fn(async () => ({ ok: true as const })) },
  });
  return { send, pathForFile };
}

function seedStores() {
  useChatStore.setState({
    sessions: [SESSION],
    activeSessionId: SESSION.id,
    messagesBySession: {},
    loadedSessions: {},
    runningBySession: {},
    queueBySession: {},
  });
  useSettingsStore.setState({
    settings: {
      permissionMode: "default",
      agentMode: "standard",
      thinkingLevel: "medium",
      defaultModel: null,
      services: [],
      theme: "light",
      webSearch: DEFAULT_WEB_SEARCH_SETTINGS,
    } as unknown as Settings,
    loaded: true,
  });
}

/** 把文件塞进 composer 的真实入口（与 AddAttachment 落到同一个 addAttachment） */
function Adder({ file }: { file: File }) {
  const aui = useAui();
  return (
    <button
      type="button"
      data-testid="add"
      onClick={() => {
        void aui.composer.addAttachment(file);
      }}
    >
      add
    </button>
  );
}

/**
 * 等附件真正就绪（探测完成），再发送。
 *
 * 用 `queryAllByText` 而不是 `queryByText`：多个附件时「移除附件」会出现多次，
 * 而 `queryByText` 在多命中时直接抛错。
 */
async function attachAndSend(text: string, expectedCount = 1): Promise<void> {
  fireEvent.click(screen.getByTestId("add"));
  await waitFor(() => expect(screen.queryAllByText("移除附件")).toHaveLength(expectedCount));
  const input = screen.getByRole("combobox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: text } });
  await waitFor(() => expect(input.value).toBe(text));
  fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
}

/** 裸 base64 → 文本（渲染层测试里没有 Buffer，用 atob 解） */
function base64ToText(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 最近一次 chat.send 的附件参数 */
function sentAttachments(send: ReturnType<typeof vi.fn>): ChatAttachment[] {
  const call = send.mock.calls.at(-1) as unknown[] | undefined;
  return (call?.[2] ?? []) as ChatAttachment[];
}

/** 当前会话最后一条消息（乐观消息） */
function lastMessage(): ChatMessage | undefined {
  return useChatStore.getState().messagesBySession[SESSION.id]?.at(-1);
}

describe("附件的端到端传递", () => {
  beforeEach(() => {
    seedStores();
  });

  it("keeps each session's text and attachments when switching", async () => {
    const { send } = stubBridge();
    useChatStore.setState({ sessions: [SESSION, { ...SESSION, id: "s2" }] });
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={new File(["draft body"], "draft.txt", { type: "text/plain" })} />
      </OintRuntimeProvider>,
    );
    const input = screen.getByRole("combobox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "session one draft" } });
    fireEvent.click(screen.getByTestId("add"));
    await waitFor(() => expect(screen.queryAllByText("移除附件")).toHaveLength(1));
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    expect(input.value).toBe("");
    expect(screen.queryAllByText("移除附件")).toHaveLength(0);
    fireEvent.change(input, { target: { value: "session two draft" } });
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s1" });
    });
    await waitFor(() => expect(input.value).toBe("session one draft"));
    await waitFor(() => expect(screen.queryAllByText("移除附件")).toHaveLength(1));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(sentAttachments(send)[0]?.name).toBe("draft.txt");
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    expect(input.value).toBe("session two draft");
  });

  it("restores rejected send text and attachment without leaving an optimistic duplicate", async () => {
    const { send } = stubBridge();
    send.mockRejectedValueOnce(new Error("offline"));
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={new File(["draft"], "retry.txt", { type: "text/plain" })} />
      </OintRuntimeProvider>,
    );
    await attachAndSend("retry request");
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("retry request"),
    );
    expect(screen.queryAllByText("移除附件")).toHaveLength(1);
    expect(useChatStore.getState().messagesBySession.s1).toEqual([]);
    expect(screen.getByText("发送失败，草稿已保留，请重试")).toBeDefined();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(sentAttachments(send)[0]?.name).toBe("retry.txt");
  });

  it("restores the first failed send into its newly created session", async () => {
    const { send } = stubBridge();
    useChatStore.setState({ activeSessionId: null, sessions: [] });
    const create = vi
      .spyOn(useChatStore.getState(), "createSession")
      .mockImplementation(async () => {
        useChatStore.setState({ sessions: [SESSION], activeSessionId: SESSION.id });
      });
    send.mockRejectedValueOnce(new Error("offline"));
    render(
      <OintRuntimeProvider>
        <Composer />
      </OintRuntimeProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "first request" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe("first request"),
    );
    expect(useChatStore.getState().activeSessionId).toBe(SESSION.id);
    create.mockRestore();
  });

  it("does not send a slash message into a session selected while resolution is pending", async () => {
    const { send } = stubBridge();
    let finish!: (value: []) => void;
    vi.mocked(window.oint.skills.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    useChatStore.setState({ sessions: [SESSION, { ...SESSION, id: "s2" }] });
    render(
      <OintRuntimeProvider>
        <Composer />
      </OintRuntimeProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "/unknown request" } });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    await act(async () => {
      finish([]);
    });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect((send.mock.calls[0] as unknown[])[0]).toBe(SESSION.id);
  });

  it("does not compact another session after a pending command resolves", async () => {
    stubBridge();
    let finish!: (value: []) => void;
    vi.mocked(window.oint.skills.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const compact = vi.spyOn(useChatStore.getState(), "compact");
    useChatStore.setState({ sessions: [SESSION, { ...SESSION, id: "s2" }] });
    render(
      <OintRuntimeProvider>
        <Composer />
      </OintRuntimeProvider>,
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "/compact keep details" } });
    fireEvent.click(screen.getByRole("button", { name: "发送" }));
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s2" });
    });
    await act(async () => {
      finish([]);
    });
    expect(compact).not.toHaveBeenCalled();
    await act(async () => {
      useChatStore.setState({ activeSessionId: "s1" });
    });
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLTextAreaElement).value).toBe(
        "/compact keep details",
      ),
    );
    compact.mockRestore();
  });

  it("文本文件：正文读出、附件真的进了 chat.send、乐观消息里有附件卡片", async () => {
    const { send } = stubBridge();
    const file = new File(["# 标题\n正文"], "notes.md", { type: "text/markdown" });
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={file} />
      </OintRuntimeProvider>,
    );

    await attachAndSend("看看这个");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const [sessionId, text, attachments, messageId] = send.mock.calls[0] as unknown as [
      string,
      string,
      ChatAttachment[],
      string,
    ];
    expect(sessionId).toBe(SESSION.id);
    expect(text).toBe("看看这个");
    expect(messageId).toBe(lastMessage()?.id);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      kind: "text",
      name: "notes.md",
      mimeType: "text/markdown",
    });
    // 没有磁盘路径（剪贴板/Blob 形状）时必须把字节 base64 带上，否则主进程落不了盘
    expect(attachments[0]?.path).toBeUndefined();
    expect(attachments[0]?.data).toBeTypeOf("string");
    expect(base64ToText(attachments[0]?.data ?? "")).toBe("# 标题\n正文");

    // 乐观消息：一条文本 + 一条附件 part（缩略图没有，文本文件没有图）
    expect(lastMessage()?.parts.map((part) => part.type)).toEqual(["text", "attachment"]);
    expect(lastMessage()?.parts[1]).toMatchObject({
      type: "attachment",
      kind: "text",
      name: "notes.md",
      index: 1,
    });
  });

  it("有磁盘路径时只带路径，不再把整个文件 base64 一遍", async () => {
    const { send, pathForFile } = stubBridge({ pathForFile: "D:/proj/notes.md" });
    const file = new File(["hi"], "notes.md", { type: "text/markdown" });
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={file} />
      </OintRuntimeProvider>,
    );

    await attachAndSend("看看这个");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(pathForFile).toHaveBeenCalled();
    const attachments = sentAttachments(send);
    expect(attachments[0]?.path).toBe("D:/proj/notes.md");
    expect(attachments[0]?.data).toBeUndefined();
  });

  it("图片：降采样后带上图块与缩略图（模型真的看得到）", async () => {
    installCanvasShims();
    const { send } = stubBridge();
    const file = new File(
      [
        new Uint8Array(
          atob(PNG_B64)
            .split("")
            .map((c) => c.charCodeAt(0)),
        ),
      ],
      "shot.png",
      {
        type: "image/png",
      },
    );
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={file} />
      </OintRuntimeProvider>,
    );

    await attachAndSend("看这张图");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const attachments = sentAttachments(send);
    expect(attachments[0]).toMatchObject({ kind: "image", name: "shot.png" });
    // 4000×3000 超过长边上限 → 必须降采样，并在附件上留下痕迹（信封要如实说明）
    expect(attachments[0]?.downscaled).toBe(true);
    expect(attachments[0]?.images).toEqual([{ mimeType: "image/png", data: PNG_B64 }]);
    expect(attachments[0]?.width).toBe(1568);
    expect(attachments[0]?.height).toBe(1176);

    const part = lastMessage()?.parts[1];
    expect(part).toMatchObject({ type: "attachment", kind: "image", name: "shot.png" });
    expect((part as { frames?: { dataUrl: string }[] }).frames?.[0]?.dataUrl).toBe(
      `data:image/png;base64,${PNG_B64}`,
    );
  });

  it("其他二进制：只带路径、不带图，交给模型用工具读", async () => {
    const { send } = stubBridge({ pathForFile: "D:/proj/report.pdf" });
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "report.pdf", {
      type: "application/pdf",
    });
    render(
      <OintRuntimeProvider>
        <Composer />
        <Adder file={file} />
      </OintRuntimeProvider>,
    );

    await attachAndSend("看这份报告");
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    const attachments = sentAttachments(send);
    expect(attachments[0]).toMatchObject({
      kind: "file",
      name: "report.pdf",
      path: "D:/proj/report.pdf",
    });
    expect(attachments[0]?.images).toBeUndefined();
  });

  it("多个附件按选择顺序排在一条消息里，序号连续", async () => {
    const { send } = stubBridge();
    const files = [
      new File(["a"], "a.md", { type: "text/markdown" }),
      new File(["b"], "b.txt", { type: "text/plain" }),
    ];
    function MultiAdder() {
      const aui = useAui();
      return (
        <button
          type="button"
          data-testid="add"
          onClick={() => {
            for (const file of files) void aui.composer.addAttachment(file);
          }}
        >
          add
        </button>
      );
    }
    render(
      <OintRuntimeProvider>
        <Composer />
        <MultiAdder />
      </OintRuntimeProvider>,
    );

    await attachAndSend("两个文件", 2);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

    expect(sentAttachments(send).map((item) => item.name)).toEqual(["a.md", "b.txt"]);
    expect(
      lastMessage()?.parts.map((part) =>
        part.type === "attachment" ? `${part.index}:${part.name}` : part.type,
      ),
    ).toEqual(["text", "1:a.md", "2:b.txt"]);
  });
});
