import { describe, expect, it } from "vitest";

import { extractTitle } from "./title-generator";

describe("extractTitle", () => {
  it("parses a strict JSON title", () => {
    expect(extractTitle('{"title":"实现用户登录功能"}')).toBe("实现用户登录功能");
  });

  it("extracts a labeled title when the model does not return valid JSON", () => {
    expect(
      extractTitle(`
        下面是结果：
        title: 实现用户登录功能
      `),
    ).toBe("实现用户登录功能");
  });

  it("extracts title from noisy fenced output", () => {
    expect(
      extractTitle(`
        \`\`\`text
        标题：为 Electron 应用增加自动更新
        \`\`\`
      `),
    ).toBe("为 Electron 应用增加自动更新");
  });

  it("repairs json-like title output with bare key and single quotes", () => {
    expect(extractTitle("{title: '实现用户登录功能',}" )).toBe("实现用户登录功能");
  });

  it("extracts title from explanatory free text", () => {
    expect(
      extractTitle("这里是生成的标题：实现用户登录功能"),
    ).toBe("实现用户登录功能");
  });

  it("prefers the first meaningful title-like line from prose", () => {
    expect(
      extractTitle(`
        以下是建议标题
        为 Electron 应用增加自动更新
        原因：这能概括核心任务
      `),
    ).toBe("为 Electron 应用增加自动更新");
  });
});
