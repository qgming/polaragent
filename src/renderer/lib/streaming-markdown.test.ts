import { describe, expect, it } from "vitest";
import { splitStreamingMarkdown } from "./streaming-markdown";

/** 便捷断言：把 tail 归一成可比较的形状 */
function tailOf(text: string) {
  const { tail } = splitStreamingMarkdown(text);
  return tail === null
    ? null
    : tail.kind === "code"
      ? { kind: "code", language: tail.language }
      : { kind: "markdown" };
}

describe("splitStreamingMarkdown", () => {
  it("单段文本全部进尾段（还没出现可切的块）", () => {
    const { blocks, tail } = splitStreamingMarkdown("第一段还在写");
    expect(blocks).toEqual([]);
    expect(tail).toEqual({ kind: "markdown", text: "第一段还在写" });
  });

  it("空行把完成的段落切进 blocks，尾段只剩最后一段", () => {
    const { blocks, tail } = splitStreamingMarkdown("第一段。\n\n第二段。\n\n第三段还在");
    expect(blocks).toEqual(["第一段。\n\n", "第二段。\n\n"]);
    expect(tail).toEqual({ kind: "markdown", text: "第三段还在" });
  });

  it("切出来的是前缀：文本继续增长时已有块保持不变（memo 才能命中）", () => {
    const short = splitStreamingMarkdown("甲。\n\n乙。\n\n丙");
    const grown = splitStreamingMarkdown("甲。\n\n乙。\n\n丙丁戊");
    expect(grown.blocks[0]).toBe(short.blocks[0]);
    expect(grown.blocks[1]).toBe(short.blocks[1]);
  });

  it("未闭合的围栏整块进尾段，作为纯代码", () => {
    const { blocks, tail } = splitStreamingMarkdown("说明。\n\n```ts\nconst a = 1;\n");
    expect(blocks).toEqual(["说明。\n\n"]);
    expect(tail).toEqual({ kind: "code", language: "ts", code: "const a = 1;\n" });
  });

  it("围栏闭合后成为已完成的块，后面继续写新段落", () => {
    const { blocks, tail } = splitStreamingMarkdown("```ts\nconst a = 1;\n```\n后面还在写");
    expect(blocks).toEqual(["```ts\nconst a = 1;\n```"]);
    expect(tail).toEqual({ kind: "markdown", text: "\n后面还在写" });
  });

  it("围栏内部的空行不切块", () => {
    const { blocks, tail } = splitStreamingMarkdown("前文。\n\n```py\na = 1\n\nb = 2\n```\n");
    // 围栏闭合行之后才切：blocks 里是「前文 + 整个围栏」，尾段只剩闭合行后的空内容
    expect(blocks.join("")).toContain("a = 1\n\nb = 2");
    expect(tail).toBeNull();
  });

  it("波浪号围栏与反引号围栏互不干扰", () => {
    const { blocks, tail } = splitStreamingMarkdown("~~~\ncode\n~~~~\n```\nstill");
    expect(blocks).toEqual(["~~~\ncode\n~~~~"]);
    expect(tail).toEqual({ kind: "code", language: undefined, code: "still" });
  });

  it("空行后面跟着列表项时不切：切开会让编号重启 / 列表分家", () => {
    const text = "1. 一\n\n2. 二\n\n3. 三";
    const { blocks, tail } = splitStreamingMarkdown(text);
    expect(blocks).toEqual([]);
    expect(tail).toEqual({ kind: "markdown", text });
  });

  it("引用与表格行同样视为延续，不切", () => {
    expect(splitStreamingMarkdown("> a\n\n> b").blocks).toEqual([]);
    expect(splitStreamingMarkdown("| a |\n\n| b |").blocks).toEqual([]);
  });

  it("标题等独立块在空行处照常切", () => {
    const { blocks, tail } = splitStreamingMarkdown("# 标题\n\n正文还在");
    expect(blocks).toEqual(["# 标题\n\n"]);
    expect(tail).toEqual({ kind: "markdown", text: "正文还在" });
  });

  it("尾部空行不算内容：不产生空洞的尾段", () => {
    const { blocks, tail } = splitStreamingMarkdown("只有一段。\n\n");
    expect(blocks).toEqual([]);
    expect(tail).toEqual({ kind: "markdown", text: "只有一段。\n\n" });
  });

  it("围栏信息串解析出语言名", () => {
    expect(tailOf("```python {1,3}\nprint(1)")).toEqual({ kind: "code", language: "python" });
    expect(tailOf("```\nplain")).toEqual({ kind: "code", language: undefined });
  });

  it("空文本既没有块也没有尾段", () => {
    expect(splitStreamingMarkdown("")).toEqual({ blocks: [], tail: null });
  });
});
