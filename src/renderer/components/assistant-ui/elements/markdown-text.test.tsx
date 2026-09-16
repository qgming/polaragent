/**
 * 流式 Markdown 的分段渲染：行为与解析次数。
 *
 * 这里钉的是性能修复本身而不是排版细节：库自带的流式实现每帧整篇重解析，实测在
 * 长回复上把主线程吃满（滚动/点击排队 → 「界面卡死」）。修法的核心承诺是
 * **已完成的块不再重新解析**，所以断言分两层：
 *   · 结构：流式中普通段落进稳定块、未闭合围栏按纯代码呈现（不带语法高亮）；
 *   · 解析次数：尾段增长时，已完成块的解析次数**不增加**（用 react-markdown 的调用计数观察）。
 */

import { TextMessagePartProvider } from "@assistant-ui/react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/renderer/i18n";
import { MarkdownText } from "./markdown-text";

/** react-markdown 的解析计数：每次真正解析（组件执行）都 +1 */
const parseCount = vi.hoisted(() => ({ value: 0 }));

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-markdown")>();
  const Wrapped = (props: Parameters<typeof actual.default>[0]) => {
    parseCount.value += 1;
    return actual.default(props);
  };
  return { default: Wrapped };
});

beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
  parseCount.value = 0;
});

afterEach(() => {
  cleanup();
});

function renderStreaming(text: string): ReturnType<typeof render> {
  return render(
    <TextMessagePartProvider text={text} isRunning>
      <MarkdownText />
    </TextMessagePartProvider>,
  );
}

describe("流式 Markdown 的分段渲染", () => {
  it("完成的段落与实时尾段都渲染出来（内容不丢）", () => {
    renderStreaming("第一段已经写完。\n\n第二段还在往下写");
    const paragraphs = document.querySelectorAll("p.aui-md-p");
    expect(Array.from(paragraphs, (node) => node.textContent)).toEqual([
      "第一段已经写完。",
      "第二段还在往下写",
    ]);
  });

  it("未闭合的围栏按纯代码渲染：跳过语法高亮与 markdown 语义", () => {
    renderStreaming("说明文字。\n\n```ts\nconst a = # 不是标题\n");
    // 高亮容器带 streaming 标记（渲染纯文本，不做 tokenize）
    const container = document.querySelector(".aui-shiki-streaming");
    expect(container).not.toBeNull();
    expect(container?.textContent).toContain("const a = # 不是标题");
    // 围栏内容不会被解析成标题
    expect(document.querySelector("h1")).toBeNull();
  });

  it("尾段增长不触发已完成块的重新解析", () => {
    const { rerender } = render(
      <TextMessagePartProvider text={"完成的块。\n\n尾段一"} isRunning>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    const afterFirst = parseCount.value;
    expect(afterFirst).toBeGreaterThan(0);

    // 只动尾段：稳定块（"完成的块。\n\n"）内容不变，memo 应挡住它的重新解析
    rerender(
      <TextMessagePartProvider text={"完成的块。\n\n尾段一还在继续"} isRunning>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    expect(parseCount.value).toBe(afterFirst + 1);

    // 再长一次：仍然只有尾段那一次解析
    rerender(
      <TextMessagePartProvider text={"完成的块。\n\n尾段一还在继续，又长了一点"} isRunning>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    expect(parseCount.value).toBe(afterFirst + 2);
  });

  it("新块出现时只解析新增块与尾段，旧块仍不重解析", () => {
    const { rerender } = render(
      <TextMessagePartProvider text={"甲。\n\n乙"} isRunning>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    const before = parseCount.value;

    // 「乙」被空行终结：它从尾段变成稳定块（新增一次解析），并出现新的尾段（再解析一次）
    rerender(
      <TextMessagePartProvider text={"甲。\n\n乙。\n\n丙"} isRunning>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    // 旧块「甲。」没有重新解析：增量是 2（新的稳定块 + 新尾段），不是 3
    expect(parseCount.value).toBe(before + 2);
  });

  it("消息跑完后整篇一次性渲染（分段只服务流式期间）", () => {
    const text = "第一段。\n\n```ts\nconst a = 1;\n```\n\n第三段。";
    const { rerender } = renderStreaming(text);
    const streamingParses = parseCount.value;

    rerender(
      <TextMessagePartProvider text={text}>
        <MarkdownText />
      </TextMessagePartProvider>,
    );
    // 完成态：一次解析覆盖整篇，段落照常渲染（两个段落 + 一个代码块）
    expect(parseCount.value).toBe(streamingParses + 1);
    expect(document.querySelectorAll("p.aui-md-p")).toHaveLength(2);
    expect(screen.getByText(/const a = 1;/)).toBeTruthy();
  });
});
