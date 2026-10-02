/**
 * 附件卡片在**真实 Thread 里**的接线测试（ui project / jsdom）。
 *
 * 为什么还要这一层：`Composer.attachment.test.tsx` 证明附件真的发给了主进程，
 * `message-mapper.test.ts` 证明历史回读能把它还原成 `AttachmentPart` —— 但两样都证明不了
 * **消息区到底画不画得出来**。
 *
 * 而这一块恰恰是最容易静默失效的地方：附件卡片走的是 assistant-ui 的 `data` part 槽位，
 * 派发靠 `MessagePrimitive.Parts` 的 `components.data.by_name`。键名或 part 名对不上时
 * 组件不会报错、不会渲染任何东西 —— 界面上就是「消息里什么都没有」，与当初那个
 * 「图片从来没发出去」的症状一模一样（那一处也是接线断了、但全程无报错）。
 *
 * 所以这里从 store 灌一条带附件的用户消息、渲染真 ThreadView，再断言界面上有卡片。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { OintRuntimeProvider } from "@/renderer/runtime/OintRuntimeProvider";
import { useChatStore } from "@/renderer/stores/chat-store";
import type { ChatMessage, SessionSummary } from "@/shared/contracts";
import type { AttachmentPart } from "@/shared/contracts/attachment";
import { ThreadView } from "./Thread";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

/** provider 会订阅主进程事件流；onEvent 必须返回取消订阅函数，否则卸载时 TypeError */
function stubBridge() {
  vi.stubGlobal("oint", {
    chat: { onEvent: () => () => {} },
    subagents: { onEvent: () => () => {}, runs: async () => [] },
    app: { openPath: async () => ({ ok: true }) },
  });
}

const SESSION: SessionSummary = {
  id: "s1",
  title: "测试会话",
  createdAt: 0,
  updatedAt: 0,
  cwd: "D:/dev/project",
  archived: false,
  pinned: false,
  messageCount: 2,
  model: null,
};

function userMessageWithAttachments(parts: AttachmentPart[]): ChatMessage {
  return {
    id: "u1",
    role: "user",
    createdAt: 0,
    parts: [{ type: "text", text: "看这几个文件" }, ...parts],
    status: "complete",
  };
}

function renderThread(messages: ChatMessage[]) {
  stubBridge();
  useChatStore.setState({
    activeSessionId: SESSION.id,
    sessions: [SESSION],
    messagesBySession: { [SESSION.id]: messages },
    runningBySession: {},
  });
  return render(
    <OintRuntimeProvider>
      <ThreadView />
    </OintRuntimeProvider>,
  );
}

beforeEach(() => {
  useChatStore.setState({ activeSessionId: null, sessions: [], messagesBySession: {} });
});

describe("附件卡片在消息流里", () => {
  it("图片：画出缩略图（data URL），名字与「已压缩」都在", () => {
    const { container } = renderThread([
      userMessageWithAttachments([
        {
          type: "attachment",
          index: 1,
          kind: "image",
          name: "shot.png",
          mimeType: "image/png",
          size: 204_800,
          path: "D:/dev/project/attachments/s1/abc.png",
          frames: [{ mimeType: "image/png", dataUrl: `data:image/png;base64,${PNG_B64}` }],
          width: 1568,
          height: 1176,
          downscaled: true,
        },
      ]),
    ]);

    const card = container.querySelector('[data-slot="attachment-card"]');
    expect(card).toBeTruthy();
    expect(card?.getAttribute("data-kind")).toBe("image");
    expect(screen.getByText("shot.png")).toBeTruthy();
    // 降采样必须让用户看见：否则他会以为模型看的就是原图
    expect(screen.getByText(/已压缩/)).toBeTruthy();
    // 缩略图用的是 part 里带的帧，不必再去读盘
    const img = container.querySelector<HTMLImageElement>('img[src^="data:image/png"]');
    expect(img?.getAttribute("src")).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it("视频：首帧 + 时长 + 抽帧数（用户要知道模型只看得到那几帧）", () => {
    const { container } = renderThread([
      userMessageWithAttachments([
        {
          type: "attachment",
          index: 1,
          kind: "video",
          name: "demo.mp4",
          mimeType: "video/mp4",
          size: 1_048_576,
          path: "D:/dev/project/demo.mp4",
          frames: [
            { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,QQ==" },
            { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,Qg==" },
            { mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,Qw==" },
          ],
          frameCount: 3,
          durationSeconds: 12.4,
          width: 1920,
          height: 1080,
        },
      ]),
    ]);

    const card = container.querySelector('[data-slot="attachment-card"]');
    expect(card?.getAttribute("data-kind")).toBe("video");
    expect(screen.getByText("demo.mp4")).toBeTruthy();
    expect(screen.getByText(/3 帧/)).toBeTruthy();
    // 播放角标：说明这是视频而不是一张图
    expect(container.querySelector('[data-slot="attachment-play"]')).toBeTruthy();
  });

  it("文本与二进制：图标 + 名字 + 读数，没有缩略图", () => {
    const { container } = renderThread([
      userMessageWithAttachments([
        {
          type: "attachment",
          index: 1,
          kind: "text",
          name: "notes.md",
          mimeType: "text/markdown",
          size: 2048,
          path: "D:/dev/project/notes.md",
          totalLines: 42,
        },
        {
          type: "attachment",
          index: 2,
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 4096,
          path: "D:/dev/project/report.pdf",
        },
      ]),
    ]);

    const cards = container.querySelectorAll('[data-slot="attachment-card"]');
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("data-kind")).toBe("text");
    expect(cards[1]?.getAttribute("data-kind")).toBe("file");
    expect(screen.getByText(/42 行/)).toBeTruthy();
    // 没有帧就画图标，不能出现空的缩略图框
    expect(container.querySelectorAll('[data-slot="attachment-thumb"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-slot="attachment-icon"]')).toHaveLength(2);
  });

  it("点击非图片附件交给系统默认程序打开（用落盘路径）", () => {
    const openPath = vi.fn(async () => ({ ok: true as const }));
    const { container } = renderThread([
      userMessageWithAttachments([
        {
          type: "attachment",
          index: 1,
          kind: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 4096,
          path: "D:/dev/project/report.pdf",
        },
      ]),
    ]);
    vi.stubGlobal("oint", {
      chat: { onEvent: () => () => {} },
      subagents: { onEvent: () => () => {}, runs: async () => [] },
      app: { openPath },
    });

    const card = container.querySelector('[data-slot="attachment-card"]');
    expect(card).toBeTruthy();
    fireEvent.click(card as Element);
    expect(openPath).toHaveBeenCalledWith("D:/dev/project/report.pdf");
  });

  it("还没有落盘路径时明说「稍后可打开」，而不是静默不可点", () => {
    renderThread([
      userMessageWithAttachments([
        {
          type: "attachment",
          index: 1,
          kind: "image",
          name: "shot.png",
          mimeType: "image/png",
          size: 2048,
          frames: [{ mimeType: "image/png", dataUrl: `data:image/png;base64,${PNG_B64}` }],
        },
      ]),
    ]);
    expect(screen.getByText("尚未落盘，稍后可打开")).toBeTruthy();
  });
});
