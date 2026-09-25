/**
 * 文件面板的测试（ui project / jsdom）。
 *
 * 这一组盯的是**两处看文件的能力必须一致**（用户要求）：从目录树点开一个文件，
 * 与从对话卡片点开，走的是同一个查看器 —— 所以「渲染 / 原始」切换、markdown 渲染、
 * 代码高亮、原始档可编辑可保存，在文件面板里同样成立。
 *
 * 另外两条是导航的位置：返回**在标题左侧**（它是「上一屏」，不是这一屏能做的动作），
 * 以及列表里对「有未保存改动」的文件打标记。
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FilesPanel } from "@/renderer/features/right-panel/FilesPanel";
import { resetUnsavedEdits } from "@/renderer/features/right-panel/unsaved-edits";
import i18n from "@/renderer/i18n";
import { useChatStore } from "@/renderer/stores/chat-store";
import { useProjectsStore } from "@/renderer/stores/projects-store";

const ROOT = "D:/proj";

const FILES = [
  { path: `${ROOT}/src`, name: "src", kind: "directory" as const },
  { path: `${ROOT}/a.md`, name: "a.md", kind: "file" as const, size: 12 },
  { path: `${ROOT}/b.ts`, name: "b.ts", kind: "file" as const, size: 24 },
];

/** 装一个 files 桥的替身：列目录固定一层，读文件回固定正文 */
function stubFiles(text: string, writes: unknown[] = []): void {
  vi.stubGlobal("oint", {
    files: {
      listDirectory: () =>
        Promise.resolve({
          path: ROOT,
          root: ROOT,
          parent: null,
          entries: FILES,
          truncated: false,
        }),
      readFile: (request: { path: string }) =>
        Promise.resolve({
          path: request.path,
          text,
          truncated: false,
          size: text.length,
          binary: false,
        }),
      writeFile: (request: unknown) => {
        writes.push(request);
        const { text: written } = request as { text: string };
        return Promise.resolve({ path: request as string, bytes: written.length });
      },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetUnsavedEdits();
  // 项目列表是全局 store：一个用例改了它，下一个用例就不该继承
  useProjectsStore.setState({ projects: [] });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

beforeEach(() => {
  useChatStore.setState({
    activeSessionId: "s1",
    sessions: [{ id: "s1", cwd: ROOT, title: "t", createdAt: 0, updatedAt: 0 } as never],
  });
});

async function renderPanel() {
  render(<FilesPanel />);
  await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
}

describe("从目录树点开一个文件", () => {
  it("markdown 默认按渲染显示，与对话里的查看器同一套", async () => {
    stubFiles("# 标题一");
    await renderPanel();

    fireEvent.click(screen.getByText("a.md"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "标题一" })).toBeTruthy());
    expect(screen.getByLabelText("源码显示")).toBeTruthy();
  });

  it("代码文件也有渲染档，原始档可编辑可保存", async () => {
    const writes: unknown[] = [];
    stubFiles("const a = 1;", writes);
    await renderPanel();

    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() => expect(screen.getByLabelText("渲染显示")).toBeTruthy());

    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "const a = 2;" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toEqual({ sessionId: "s1", path: `${ROOT}/b.ts`, text: "const a = 2;" });
  });
});

describe("返回的位置", () => {
  it("看文件时返回在标题左侧（名字前面）", async () => {
    stubFiles("x");
    await renderPanel();
    fireEvent.click(screen.getByText("a.md"));

    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    const back = screen.getByLabelText("返回列表");
    const title = document.querySelector("h3");
    expect(title).not.toBeNull();
    // 文档顺序：返回按钮在标题之前 = 视觉上的左侧
    expect(back.compareDocumentPosition(title as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("列目录时「返回上级」同样在标题左侧", async () => {
    stubFiles("x");
    await renderPanel();

    const parent = screen.getByLabelText("返回上级");
    const title = document.querySelector("h3");
    expect(parent.compareDocumentPosition(title as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // 根目录的上一级是 null：按钮在但不可按
    expect(parent.hasAttribute("disabled")).toBe(true);
  });
});

describe("未保存改动的标记", () => {
  it("回到列表后，改过的文件带「未保存」标记", async () => {
    stubFiles("const a = 1;");
    await renderPanel();

    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() => expect(screen.getByLabelText("源码显示")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("源码显示"));
    fireEvent.change(screen.getByLabelText("编辑文件内容"), { target: { value: "const a = 9;" } });

    fireEvent.click(screen.getByLabelText("返回列表"));

    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    expect(screen.getByText("未保存")).toBeTruthy();

    // 再点开还是那份没保存的正文
    fireEvent.click(screen.getByText("b.ts"));
    await waitFor(() => expect(screen.getByLabelText("源码显示")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("源码显示"));
    expect(screen.getByLabelText("编辑文件内容")).toHaveProperty("value", "const a = 9;");
  });
});

/**
 * 「会话没有绑定工作目录」不再是一种界面状态。
 *
 * 早先渲染层把 cwd 缺失当空态，而主进程那边是直接报错（「该会话未绑定工作目录」）——
 * 用户看到的是「模型写过的文件在右侧一律打不开」。现在根由主进程现补一个本会话的
 * 临时目录，所以**只要有会话就该把列表画出来**，渲染层不再拿 cwd 当开关。
 */
describe("没有绑定工作目录的会话", () => {
  /** 列一个空目录：用来看空态那一屏 */
  function stubEmptyDirectory(): void {
    vi.stubGlobal("oint", {
      files: {
        listDirectory: () =>
          Promise.resolve({ path: ROOT, root: ROOT, parent: null, entries: [], truncated: false }),
        readFile: () => Promise.resolve(null),
        writeFile: () => Promise.resolve(null),
      },
    });
  }

  it("仍然列出主进程给的目录，而不是显示空态", async () => {
    useChatStore.setState({
      activeSessionId: "s1",
      sessions: [{ id: "s1", cwd: "", title: "t", createdAt: 0, updatedAt: 0 } as never],
    });
    stubFiles("x");

    render(<FilesPanel />);

    await waitFor(() => expect(screen.getByText("a.md")).toBeTruthy());
    expect(screen.queryByText("先打开一个会话")).toBeNull();
  });

  it("没有会话时才是空态", async () => {
    useChatStore.setState({ activeSessionId: null, sessions: [] });
    stubFiles("x");

    render(<FilesPanel />);

    await waitFor(() => expect(screen.getByText("先打开一个会话")).toBeTruthy());
  });

  it("临时目录的空态说清「文件跟着会话删」，项目目录不说", async () => {
    stubEmptyDirectory();
    const { unmount } = render(<FilesPanel />);
    await waitFor(() => expect(screen.getByText("这个目录是空的")).toBeTruthy());
    expect(screen.getByText(/临时目录/)).toBeTruthy();

    // 会话绑在项目目录里：那些文件是用户的，不跟着会话删，所以不能提临时目录
    unmount();
    useProjectsStore.setState({
      projects: [{ id: "p1", name: "proj", path: ROOT, createdAt: 0 }],
    });
    render(<FilesPanel />);
    await waitFor(() => expect(screen.getByText("这个目录是空的")).toBeTruthy());
    expect(screen.queryByText(/临时目录/)).toBeNull();
  });
});
