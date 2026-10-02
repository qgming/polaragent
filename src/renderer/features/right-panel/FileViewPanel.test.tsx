/**
 * 右栏文件查看器的测试（ui project / jsdom）。
 *
 * 钉住四件事：
 *   1. **markdown 默认按渲染显示**（用户明确要求），且顶部能切到源码；
 *   2. **代码文件也有渲染档**（用户要求）：渲染档只读、原始档可编辑 —— 两档的差别是
 *      「有没有可编辑的正文」，不是「有没有 pre」；
 *   3. **不可渲染的文件不给切换按钮** —— 给一个点了没变化的按钮比不给更糟
 *      （这条原则在本仓已有先例，见 job-tool-ui.test.tsx 的「不摆点了没反应的按钮」）；
 *   4. 原始档的编辑与保存：未保存可见、Ctrl/Cmd+S 同效、失败显示主进程给的中文，
 *      以及**换文件不会丢掉没保存的正文**。
 *
 * 文件内容走 `files.readFile`，**根由主进程解析**：这里断言请求里带的是
 * sessionId + 绝对路径，不含 root（那是提权面，见 main/ipc/files.ts）。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewPanel } from "@/renderer/features/right-panel/FileViewPanel";
import {
  resetUnsavedEdits,
  unsavedBaseOf,
  unsavedOf,
} from "@/renderer/features/right-panel/unsaved-edits";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useUiStore } from "@/renderer/stores/ui-store";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useUiStore.setState({ filePanelTarget: null });
  // 未保存的草稿是模块级状态，不随卸载消失：不清会把一条用例的编辑带到下一条里
  resetUnsavedEdits();
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useChatStore.setState({ activeSessionId: "s1" });
});

/** 装一个 files 桥的替身：记录读与写的请求 */
function stubFiles(text: string): { reads: unknown[]; writes: unknown[] } {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  vi.stubGlobal("oint", {
    files: {
      readFile: (request: unknown) => {
        reads.push(request);
        return Promise.resolve({
          path: "x",
          text,
          truncated: false,
          size: text.length,
          binary: false,
        });
      },
      writeFile: (request: unknown) => {
        writes.push(request);
        const { text: written } = request as { text: string };
        return Promise.resolve({ path: "x", bytes: written.length });
      },
    },
  });
  return { reads, writes };
}

async function open(path: string) {
  useUiStore.setState({ filePanelTarget: path });
  render(<FileViewPanel />);
  // 等读取落地：源码档与渲染档都依赖 content
  await waitFor(() => expect(screen.queryByText("加载中…")).toBeNull());
}

/** 换一个文件（走 store，和用户点另一张文件卡片是同一条路径） */
async function reopen(path: string) {
  useUiStore.setState({ filePanelTarget: path });
  await waitFor(() => expect(screen.queryByText("加载中…")).toBeNull());
}

const editor = (): HTMLTextAreaElement | null =>
  screen.queryByLabelText<HTMLTextAreaElement>("编辑文件内容");

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

    // 源码档是编辑区，里面留着 # 号
    expect(editor()?.value).toContain("# 标题一");
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
    expect(bridge.reads).toHaveLength(1);
  });

  it("渲染档是只读的：可编辑的正文只在原始档", async () => {
    stubFiles("# 标题一");
    await open("D:/dev/project/notes.md");

    expect(editor()).toBeNull();
    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(editor()).not.toBeNull();
  });
});

describe("代码文件", () => {
  it("也有渲染档（语法高亮，只读），切到原始档才能编辑", async () => {
    stubFiles("export const a = 1;");
    await open("D:/dev/project/src/a.ts");

    // 两档都在，默认渲染档
    expect(screen.getByLabelText("渲染显示").getAttribute("aria-pressed")).toBe("true");
    expect(editor()).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("export const a = 1;");

    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(editor()?.value).toBe("export const a = 1;");
  });

  it("原始档下改正文不会立刻写盘", async () => {
    const bridge = stubFiles("const a = 1;");
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), {
      target: { value: "const a = 2;" },
    });

    expect(screen.getByText("未保存")).toBeTruthy();
    expect(bridge.writes).toHaveLength(0);
  });
});

describe("非代码文件", () => {
  it("文本文件只给源码一档，不摆一个点了没变化的切换按钮", async () => {
    stubFiles("第一行\n第二行");
    await open("D:/dev/project/notes.txt");

    expect(screen.queryByLabelText("渲染显示")).toBeNull();
    expect(screen.queryByLabelText("源码显示")).toBeNull();
    expect(editor()?.value).toContain("第一行");
  });
});

describe("编辑与保存", () => {
  it("保存把整份正文提交给主进程，并用回执更新字节数", async () => {
    const bridge = stubFiles("const a = 1;");
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), {
      target: { value: "const a = 2;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(bridge.writes).toHaveLength(1));
    expect(bridge.writes[0]).toEqual({
      sessionId: "s1",
      path: "D:/dev/project/src/a.ts",
      text: "const a = 2;",
    });
    // 保存前重新读取，避免覆盖外部修改；成功后清除未保存状态
    await waitFor(() => expect(screen.queryByText("未保存")).toBeNull());
    expect(bridge.reads).toHaveLength(2);
    expect(screen.getByText("已保存")).toBeTruthy();
  });

  it("Ctrl/Cmd + S 保存", async () => {
    const bridge = stubFiles("const a = 1;");
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    const area = screen.getByLabelText("编辑文件内容");
    fireEvent.change(area, { target: { value: "const a = 3;" } });
    fireEvent.keyDown(area, { key: "s", ctrlKey: true });

    await waitFor(() => expect(bridge.writes).toHaveLength(1));
  });

  it("保存失败时显示主进程给的中文，并且仍然是未保存", async () => {
    vi.stubGlobal("oint", {
      files: {
        readFile: () =>
          Promise.resolve({
            path: "x",
            text: "x",
            truncated: false,
            size: 1,
            binary: false,
          }),
        writeFile: () =>
          Promise.reject(new Error("写入文件失败：这个路径不在允许的工作目录内，已拒绝写入")),
      },
    });
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "y" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "这个路径不在允许的工作目录内，已拒绝写入",
      );
    });
    // 失败后正文仍然是改过的：保存按钮还能再按一次（而不是变成「已保存」）
    expect(editor()?.value).toBe("y");
    expect(screen.getByRole("button", { name: "保存" })).not.toHaveProperty("disabled", true);
  });

  it("撤销改动回到磁盘上的那一份", async () => {
    stubFiles("const a = 1;");
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "改坏了" } });
    fireEvent.click(screen.getByRole("button", { name: "撤销改动" }));

    expect(editor()?.value).toBe("const a = 1;");
    expect(screen.queryByText("未保存")).toBeNull();
  });

  it("换文件再回来，没保存的正文还在（不静默丢弃）", async () => {
    stubFiles("const a = 1;");
    await open("D:/dev/project/src/a.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), {
      target: { value: "const a = 42;" },
    });

    await reopen("D:/dev/project/src/b.ts");
    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(editor()?.value).toBe("const a = 1;");

    await reopen("D:/dev/project/src/a.ts");
    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(editor()?.value).toBe("const a = 42;");
    expect(screen.getByText("未保存")).toBeTruthy();
  });
});

describe("不能编辑的文件", () => {
  it("二进制文件不给编辑，也不摆保存按钮", async () => {
    vi.stubGlobal("oint", {
      files: {
        readFile: () =>
          Promise.resolve({ path: "x", text: "", truncated: false, size: 8, binary: true }),
      },
    });
    await open("D:/dev/project/blob.bin");

    expect(editor()).toBeNull();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
  });

  it("被截断的大文件不给编辑（写回会被主进程拒）", async () => {
    vi.stubGlobal("oint", {
      files: {
        readFile: () =>
          Promise.resolve({
            path: "x",
            text: "前一半",
            truncated: true,
            size: 999_999,
            binary: false,
          }),
      },
    });
    await open("D:/dev/project/huge.ts");

    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(editor()).toBeNull();
    expect(document.querySelector("pre")?.textContent).toContain("前一半");
  });
});

describe("读文件的请求形状", () => {
  it("只带 sessionId 与绝对路径，不带 root", async () => {
    const bridge = stubFiles("x");
    await open("D:/dev/project/a.md");

    expect(bridge.reads).toEqual([{ sessionId: "s1", path: "D:/dev/project/a.md" }]);
    // root 是提权面：渲染层给不了它（见 main/ipc/files.ts 与 files.test.ts）
    expect(Object.hasOwn(bridge.reads[0] as object, "root")).toBe(false);
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

describe("saving races", () => {
  it("keeps text typed while a save is pending", async () => {
    stubFiles("original");
    let resolveWrite!: (value: { path: string; bytes: number }) => void;
    window.oint.files.writeFile = vi.fn(
      () =>
        new Promise<{ path: string; bytes: number }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await open("D:/pending.txt");
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "submitted" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(window.oint.files.writeFile).toHaveBeenCalled());
    // Returning to the original text must remain dirty against the newly saved revision.
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "original" } });
    resolveWrite({ path: "D:/pending.txt", bytes: 9 });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "保存" })).not.toHaveProperty("disabled", true),
    );
    expect(editor()?.value).toBe("original");
    expect(screen.getByText("未保存")).toBeTruthy();
  });

  it("does not apply a late save to another file", async () => {
    stubFiles("original");
    let resolveWrite!: (value: { path: string; bytes: number }) => void;
    window.oint.files.writeFile = vi.fn(
      () =>
        new Promise<{ path: string; bytes: number }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await open("D:/first.txt");
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "submitted" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(window.oint.files.writeFile).toHaveBeenCalled());
    await reopen("D:/second.txt");
    resolveWrite({ path: "D:/first.txt", bytes: 9 });
    await waitFor(() => expect(editor()?.value).toBe("original"));
    expect(screen.queryByText("已保存")).toBeNull();
  });

  it("preserves the draft when the disk changed externally", async () => {
    stubFiles("original");
    await open("D:/external.txt");
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "my draft" } });
    window.oint.files.readFile = vi.fn(async () => ({
      path: "D:/external.txt",
      text: "external",
      size: 8,
      binary: false,
      truncated: false,
    }));
    window.oint.files.writeFile = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("alert");
    expect(window.oint.files.writeFile).not.toHaveBeenCalled();
    expect(editor()?.value).toBe("my draft");
  });
});

it.each(["navigate", "remount"])(
  "keeps newer edits after a pending save and %s back to the same file",
  async (route) => {
    stubFiles("original");
    let resolveWrite!: (value: { path: string; bytes: number }) => void;
    window.oint.files.writeFile = vi.fn(
      () =>
        new Promise<{ path: string; bytes: number }>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    await open("D:/revisited.txt");
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "submitted" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(window.oint.files.writeFile).toHaveBeenCalled());
    if (route === "navigate") {
      await reopen("D:/other.txt");
      await reopen("D:/revisited.txt");
    } else {
      cleanup();
      await open("D:/revisited.txt");
    }
    fireEvent.change(screen.getByLabelText("编辑文件内容"), {
      target: { value: "newer revision" },
    });
    resolveWrite({ path: "D:/revisited.txt", bytes: 9 });
    await waitFor(() => expect(unsavedBaseOf("D:/revisited.txt")).toBe("submitted"));
    expect(unsavedOf("D:/revisited.txt")).toBe("newer revision");
    expect(editor()?.value).toBe("newer revision");
    await reopen("D:/other.txt");
    await reopen("D:/revisited.txt");
    expect(editor()?.value).toBe("newer revision");
  },
);

it("marks a remounted viewer dirty when an older write completes after reverting", async () => {
  stubFiles("original");
  let resolveWrite!: (value: { path: string; bytes: number }) => void;
  window.oint.files.writeFile = vi.fn(
    () =>
      new Promise<{ path: string; bytes: number }>((resolve) => {
        resolveWrite = resolve;
      }),
  );
  await open("D:/revert-remount.txt");
  fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "submitted" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(window.oint.files.writeFile).toHaveBeenCalled());
  cleanup();
  await open("D:/revert-remount.txt");
  fireEvent.click(screen.getByRole("button", { name: "撤销改动" }));
  resolveWrite({ path: "D:/revert-remount.txt", bytes: 9 });
  await screen.findByText("未保存");
  expect(editor()?.value).toBe("original");
  expect(screen.getByRole("button", { name: "保存" })).not.toHaveProperty("disabled", true);
  expect(unsavedOf("D:/revert-remount.txt")).toBe("original");
  expect(unsavedBaseOf("D:/revert-remount.txt")).toBe("submitted");
});
