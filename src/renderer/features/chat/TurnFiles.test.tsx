/**
 * 「本轮文件改动」区块的行为测试（ui project / jsdom）。
 *
 * 钉住三件事 —— 它们都是「渲染成功、断言也能过」型缺陷的典型位置：
 *   1. **只有文档类出卡片**：代码文件必须只以 chip 出现，否则一次重构会铺出一面卡片墙；
 *   2. **点卡片的去向分两种**：HTML 进内置浏览器（file://），其余进右栏文件查看器；
 *   3. **同一文件改多次只占一枚 chip**，带 ×N。
 *
 * 断言口径取用户看得到的东西（文本 + store 里被写入的目标），而不是 className：
 * 卡片的列数与圆角属于样式，改样式不该让这个文件变红。
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { useUiStore } from "@/renderer/stores/ui-store";
import type { ChatMessage, ChatPart } from "@/shared/contracts/session";
import { TurnFiles } from "./TurnFiles";
import { summarizeTurnFiles } from "./turn-files";

afterEach(() => {
  cleanup();
  useUiStore.setState({
    rightPanelTabs: [],
    activeTabId: null,
    rightPanelOpen: false,
    filePanelTarget: null,
    browserOpenRequest: null,
  });
});

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

const CWD = "D:/dev/project";

/** 造一条带 write / edit 调用的助手消息 */
function assistant(
  id: string,
  calls: { toolName: string; path: string; patch?: string }[],
): ChatMessage {
  const parts = calls.map((call, index): ChatPart => {
    return {
      type: "tool-call",
      toolCallId: `${id}-${index}`,
      toolName: call.toolName,
      argsText: "{}",
      args: { path: call.path },
      status: "done",
      ...(call.patch === undefined ? {} : { details: { patch: call.patch } }),
    };
  });
  return { id, role: "assistant", createdAt: 0, parts, status: "complete" };
}

function renderTurn(calls: { toolName: string; path: string; patch?: string }[]) {
  const summary = summarizeTurnFiles([assistant("a1", calls)], CWD);
  return render(<TurnFiles summary={summary} />);
}

describe("本轮文件改动的形态", () => {
  it("标题行显示本轮改过文件，代码文件只出 chip、不出卡片", () => {
    renderTurn([
      { toolName: "write", path: "src/a.ts" },
      { toolName: "edit", path: "src/b.ts" },
      { toolName: "write", path: "README.md" },
    ]);

    expect(screen.getByText("本轮文件改动")).toBeTruthy();

    // 三个文件都在 chip 行上（可点），说明「这轮动了哪些文件」是完整的。
    // README.md 同时出现在 chip 与卡片里，所以按「至少一个」断言
    expect(screen.getAllByText("a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("b.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByText("README.md").length).toBeGreaterThan(0);

    // 卡片只有一枚：带 aria-label 的那个按钮只有 README.md
    expect(screen.getAllByLabelText(/^打开 /)).toHaveLength(1);
    expect(screen.getByLabelText("打开 README.md")).toBeTruthy();
  });

  it("同一文件改多次只占一枚 chip，并带 ×N", () => {
    renderTurn([
      { toolName: "write", path: "notes.md" },
      { toolName: "edit", path: "notes.md" },
      { toolName: "edit", path: "notes.md" },
    ]);

    // 只出现一次：没有重复的 chip 或卡片
    expect(screen.getAllByText("notes.md")).toHaveLength(2); // chip + 卡片
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("没有改动时整块不渲染", () => {
    const summary = summarizeTurnFiles([assistant("a1", [])], CWD);
    const { container } = render(<TurnFiles summary={summary} />);

    expect(container.firstChild).toBeNull();
  });
});

/**
 * 卡片区的列数随卡片数变化。
 *
 * 固定 3 列会让「只有 1 张卡」时右边空出三分之二，看起来像没渲染完 ——
 * 这是截图里肉眼发现的问题，所以补一条断言把它钉住。
 * 断言口径取 grid 容器的类名（列数就是由它决定的），而不是像素宽度：
 * jsdom 不做布局、量不到真实宽度，颜色与间距那类样式也不该由单测来锁。
 */
describe("卡片区的列数自适应", () => {
  function gridClass(count: number): string {
    const calls = Array.from({ length: count }, (_, index) => ({
      toolName: "write",
      path: `doc-${index}.md`,
    }));
    const { container } = renderTurn(calls);
    const grid = container.querySelector('[data-slot="turn-files"] > div:last-child');
    return grid?.className ?? "";
  }

  it("1 张卡占满一行", () => {
    expect(gridClass(1)).toContain("grid-cols-1");
    expect(gridClass(1)).not.toContain("md:grid-cols-3");
  });

  it("2 张卡各占一半", () => {
    expect(gridClass(2)).toContain("sm:grid-cols-2");
    expect(gridClass(2)).not.toContain("md:grid-cols-3");
  });

  it("3 张及以上最多 3 列", () => {
    expect(gridClass(3)).toContain("md:grid-cols-3");
    expect(gridClass(5)).toContain("md:grid-cols-3");
  });
});

describe("点文件卡片去向哪一栏", () => {
  it("markdown 进文件查看器，目标写进 store", () => {
    renderTurn([{ toolName: "write", path: "docs/guide.md" }]);
    fireEvent.click(screen.getByLabelText("打开 guide.md"));

    const state = useUiStore.getState();
    expect(state.rightPanelOpen).toBe(true);
    expect(state.filePanelTarget).toBe(`${CWD}/docs/guide.md`);
    // 查看器是单例视图：标签必须是 file，且只开了一个
    expect(state.rightPanelTabs).toHaveLength(1);
    expect(state.rightPanelTabs[0]?.view).toBe("file");
    // 没有走浏览器那条路
    expect(state.browserOpenRequest).toBeNull();
  });

  it("HTML 交给内置浏览器，且用 file:// 绝对地址", () => {
    renderTurn([{ toolName: "write", path: "report.html" }]);
    fireEvent.click(screen.getByLabelText("打开 report.html"));

    const state = useUiStore.getState();
    expect(state.browserOpenRequest?.url).toBe(`file:///${CWD}/report.html`);
    // 标签名先按文件名写上，等页面报真标题再覆盖
    expect(state.browserOpenRequest?.title).toBe("report.html");
    expect(state.activeTabId).toBe(state.rightPanelTabs[0]?.id);
    expect(state.rightPanelTabs[0]?.view).toBe("browser");
    // 没有顺手打开文件查看器
    expect(state.filePanelTarget).toBeNull();
  });

  it("代码文件的 chip 也可点，同样进查看器", () => {
    renderTurn([{ toolName: "write", path: "src/a.ts" }]);
    // 代码文件只出 chip，所以这个文本唯一
    fireEvent.click(screen.getByText("a.ts"));

    expect(useUiStore.getState().filePanelTarget).toBe(`${CWD}/src/a.ts`);
  });

  it("连点两张卡片复用同一个查看器标签，不堆出一排同名标签", () => {
    renderTurn([
      { toolName: "write", path: "a.md" },
      { toolName: "write", path: "b.md" },
    ]);

    fireEvent.click(screen.getByLabelText("打开 a.md"));
    fireEvent.click(screen.getByLabelText("打开 b.md"));

    const state = useUiStore.getState();
    expect(state.rightPanelTabs).toHaveLength(1);
    // 焦点停在最后点的那个文件上
    expect(state.filePanelTarget).toBe(`${CWD}/b.md`);
  });

  it("连点两次同一个 HTML 卡片会产生两次导航请求（token 递增）", () => {
    renderTurn([{ toolName: "write", path: "page.html" }]);
    const card = screen.getByLabelText("打开 page.html");

    fireEvent.click(card);
    const first = useUiStore.getState().browserOpenRequest;
    fireEvent.click(card);
    const second = useUiStore.getState().browserOpenRequest;

    // 值相同但 token 必须变：否则 BrowserPanel 的订阅会把它当成「没有变化」而漏掉第二次
    expect(second?.url).toBe(first?.url);
    expect(second?.token).toBeGreaterThan(first?.token ?? 0);
  });
});

describe("没有 cwd 时仍然显示，只是不带可打开的绝对路径", () => {
  it("cwd 缺失时卡片照常渲染，目标退回原始相对路径", () => {
    const summary = summarizeTurnFiles(
      [assistant("a1", [{ toolName: "write", path: "a.md" }])],
      undefined,
    );
    render(<TurnFiles summary={summary} />);
    fireEvent.click(screen.getByLabelText("打开 a.md"));

    // 展示与打开是两件事：卡片不该因为解析不出绝对路径就消失（点开会被主进程拒，见注释）
    expect(useUiStore.getState().filePanelTarget).toBe("a.md");
  });
});

describe("增删行数", () => {
  it("从补丁里算出来并显示在标题行", () => {
    const patch = [
      "--- a/x.md",
      "+++ b/x.md",
      "@@ -1 +1,3 @@",
      " 保留",
      "-删掉",
      "+加一",
      "+加二",
      "",
    ].join("\n");

    renderTurn([{ toolName: "edit", path: "x.md", patch }]);

    expect(screen.getByText("+2")).toBeTruthy();
    expect(screen.getByText("−1")).toBeTruthy();
  });
});

/** window 上的桥替身：卡片只写 store，不直接调 IPC；这里保证没有意外的调用 */
describe("卡片不直接碰 IPC", () => {
  it("点击只改 store，不调用 files / browser 桥", () => {
    const readFile = vi.fn();
    const registerTab = vi.fn();
    vi.stubGlobal("oint", { files: { readFile }, browser: { registerTab } });

    renderTurn([{ toolName: "write", path: "a.md" }]);
    fireEvent.click(screen.getByLabelText("打开 a.md"));

    expect(readFile).not.toHaveBeenCalled();
    expect(registerTab).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
