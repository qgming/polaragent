// truncateForModel 的单测。
//
// 这里曾覆盖「一个远端工具 = 一个宿主工具」的包装器（createMcpTool）；那套代码随暴露策略
// 一起删掉了 —— 远端工具现在只经由聚合工具暴露，转发 / 报错 / 截断的断言都在
// tools/mcp-gateway.test.ts 里，本文件只留截断规则本身。

import { describe, expect, it } from "vitest";
import { truncateForModel } from "./mcp";

describe("truncateForModel", () => {
  it("短文本不动", () => {
    expect(truncateForModel("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("超长文本保留开头并给出截断提示", () => {
    const text = Array.from({ length: 2100 }, (_unused, index) => `line-${index}`).join("\n");
    const clipped = truncateForModel(text);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.startsWith("line-0\nline-1")).toBe(true);
    expect(clipped.text.includes("结果过长已截断")).toBe(true);
    expect(clipped.text.includes("line-2099")).toBe(false);
  });

  it("行数没超但字符数超了同样截断（一行几十万字符的 JSON 也要拦住）", () => {
    const clipped = truncateForModel("x".repeat(60_000));
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.length).toBeLessThan(60_000);
  });
});
