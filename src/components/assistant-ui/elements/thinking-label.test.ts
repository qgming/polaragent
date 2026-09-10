// 运行态标签推导的回归测试。
//
// 这些用例锁住「什么时候该显示运行态提示」这条判定：它与
// MessagePrimitive.GroupedParts 默认的 no-text indicator 模式必须等价，否则
// 会出现「运行中却没有任何状态提示」的空窗。
import { describe, expect, it } from "vitest";

import { deriveThinkingLabel } from "./thinking-label";

const part = {
  text: { type: "text" },
  reasoning: { type: "reasoning" },
  pendingTool: (toolName = "bash") => ({ type: "tool-call", toolName }),
  doneTool: (toolName = "bash") => ({
    type: "tool-call",
    toolName,
    result: "ok",
  }),
  unnamedPendingTool: { type: "tool-call" },
};

describe("deriveThinkingLabel", () => {
  it("消息不在运行时不给标签", () => {
    expect(deriveThinkingLabel({ running: false, parts: [] })).toBeUndefined();
    expect(
      deriveThinkingLabel({ running: false, parts: [part.pendingTool()] }),
    ).toBeUndefined();
  });

  it("运行中但尚无任何内容时显示「思考中」", () => {
    expect(deriveThinkingLabel({ running: true, parts: [] })).toBe("思考中");
  });

  it("有工具尚未返回时汇报工具名", () => {
    expect(
      deriveThinkingLabel({ running: true, parts: [part.pendingTool("bash")] }),
    ).toBe("正在运行 bash");
  });

  it("工具缺少名字时退化为通用文案，不产出半截标签", () => {
    expect(
      deriveThinkingLabel({ running: true, parts: [part.unnamedPendingTool] }),
    ).toBe("正在运行工具");
  });

  it("结尾已是正文或思考内容时让位给真实内容", () => {
    expect(
      deriveThinkingLabel({
        running: true,
        parts: [part.doneTool(), part.text],
      }),
    ).toBeUndefined();
    expect(
      deriveThinkingLabel({ running: true, parts: [part.reasoning] }),
    ).toBeUndefined();
    expect(deriveThinkingLabel({ running: true, parts: [part.text] })).toBeUndefined();
  });

  // 这一档与库的 no-text indicator 模式对齐：工具已返回但正文未出，
  // 助手大概率还没说完，必须继续保留运行态提示。
  it("工具已返回但结尾不是正文时仍显示「思考中」", () => {
    expect(
      deriveThinkingLabel({ running: true, parts: [part.doneTool()] }),
    ).toBe("思考中");
  });

  // 有未返回的工具时优先汇报工具名，即使此前已有流式正文。
  // 这是已知的「比库的 indicator 多显示一行」的取舍，记录以防回归反转。
  it("仍有工具在跑时优先汇报工具名，不受此前正文影响", () => {
    expect(
      deriveThinkingLabel({
        running: true,
        parts: [part.text, part.pendingTool("read")],
      }),
    ).toBe("正在运行 read");
  });
});
