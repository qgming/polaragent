/**
 * 右栏文件查看器的测试（ui project / jsdom）。
 *
 * 钉住两件事：
 *   1. **markdown 默认按渲染显示**（用户明确要求），且顶部能切到源码；
 *   2. **不可渲染的文件不给切换按钮** —— 给一个点了没变化的按钮比不给更糟
 *      （这条原则在本仓已有先例，见 job-tool-ui.test.tsx 的「不摆点了没反应的按钮」）。
 *
 * 文件内容走 `files.readFile`，**根由主进程解析**：这里断言请求里带的是
 * sessionId + 绝对路径，不含 root（那是提权面，见 main/ipc/files.ts）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewPanel } from "@/renderer/features/right-panel/FileViewPanel";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.setState({ filePanelTarget: null });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1" });
});

/** 装一个 files.readFile 的替身，记录它收到的请求 */
function stubFiles(text: string): { calls: unknown[] } {
  const calls: unknown[] = [];
  vi.stubGlobal("oint", {
    files: {
      readFile: (request: unknown) => {
        calls.push(request);
        return Promise.resolve({
          path: "x",
          text,
          truncated: false,
          size: text.length,
          binary: false,
        });
      },
    },
  });
  return { calls };
}

async function open(path: string) {
  useUiStore.setState({ filePanelTarget: path });
  render(<FileViewPanel />);
  // 等读取落地：源码档与渲染档都依赖 content
  await waitFor(() => expect(screen.queryByText("加载中…")).toBeNull());
}

describe("markdown 文件的两种模式", () => {
  it("默认按渲染显示：标题渲染成真标题，源码的 # 不再出现", async () => {
    stubFiles("# 标题一\n\n正文段落。");
    await open("D:/dev/project/notes.md");

    // 渲染档：markdown 的 # 被解析成 h1，界面上看到的是纯文本「标题一」
    const heading = screen.getByRole("heading", { name: "标题一" });
    expect(heading.tagName).toBe("H1");
    expect(screen.getByText("正文段落。")).toBeTruthy();
  });

  it("切到源码后看到原始 markdown 文本", async () => {
    stubFiles("# 标题一\n\n正文段落。");
    await open("D:/dev/project/notes.md");

    fireEvent.click(screen.getByLabelText("源码显示"));

    // 源码档是一个 <pre>，里面留着 # 号
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("# 标题一");
    // 渲染出来的 h1 这时不该还在
    expect(screen.queryByRole("heading", { name: "标题一" })).toBeNull();
  });

  it("切回渲染档仍然正常（两个模式共用同一份已读到的文本）", async () => {
    const bridge = stubFiles("# 又见面了");
    await open("D:/dev/project/notes.md");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.click(screen.getByLabelText("渲染显示"));

    expect(screen.getByRole("heading", { name: "又见面了" })).toBeTruthy();
    // 切换模式不该再取一次文件
    expect(bridge.calls).toHaveLength(1);
  });
});

describe("非 markdown 文件", () => {
  it("文本文件只给源码一档，不摆一个点了没变化的切换按钮", async () => {
    stubFiles("第一行\n第二行");
    await open("D:/dev/project/notes.txt");

    expect(screen.queryByLabelText("渲染显示")).toBeNull();
    expect(screen.queryByLabelText("源码显示")).toBeNull();
    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("第一行");
  });

  it("代码文件同样只给源码", async () => {
    stubFiles("export const a = 1;");
    await open("D:/dev/project/src/a.ts");

    expect(screen.queryByLabelText("渲染显示")).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("export const a = 1;");
  });
});

describe("读文件的请求形状", () => {
  it("只带 sessionId 与绝对路径，不带 root", async () => {
    const bridge = stubFiles("x");
    await open("D:/dev/project/a.md");

    expect(bridge.calls).toEqual([{ sessionId: "s1", path: "D:/dev/project/a.md" }]);
    // root 是提权面：渲染层给不了它（见 main/ipc/files.ts 与 files.test.ts）
    expect(Object.hasOwn(bridge.calls[0] as object, "root")).toBe(false);
  });

  it("标题显示文件名，路径单独一行", async () => {
    stubFiles("x");
    await open("D:/dev/project/docs/guide.md");

    expect(screen.getByText("guide.md")).toBeTruthy();
    expect(screen.getByText("D:/dev/project/docs/guide.md")).toBeTruthy();
  });
});

describe("没有目标文件时", () => {
  it("显示空态而不是空白面板", () => {
    stubFiles("x");
    useUiStore.setState({ filePanelTarget: null });
    render(<FileViewPanel />);

    expect(screen.getByText("还没有打开任何文件")).toBeTruthy();
  });
});

describe("读取失败", () => {
  it("把错误显示出来，而不是留一个空白正文", async () => {
    vi.stubGlobal("oint", {
      files: {
        readFile: () => Promise.reject(new Error("路径不在允许的工作目录内")),
      },
    });
    await open("D:/elsewhere/a.md");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("路径不在允许的工作目录内");
    });
  });
});
