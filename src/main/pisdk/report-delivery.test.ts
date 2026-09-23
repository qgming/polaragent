// 子智能体结果组装的测试。
//
// 为什么这个文件值得存在：这次改动把报告的**形状**换了 —— 从「推一条消息给主代理」
// 改成「回填到那次 Task 调用的结果里」。用户的要求很具体（不要作为用户消息显示、
// 要有「xxx 已完成」这个状态、报告在那个状态里、主会话可以读它），
// 所以形状本身就是要被测试钉死的东西，不是实现细节。
//
// 重点覆盖三处容易写错的地方：
// 1. running 不该产出结果（否则界面会在还在跑时就盖上一个「已完成」）；
// 2. 没有报告时也要回填（只有状态也是结果；只回填有报告的会让界面永远停在 running）；
// 3. truncated / aborted 不算失败（它们是「有结果的未完成」，给红叉会误导）。

import { describe, expect, it } from "vitest";
import type { SubagentRun } from "@/shared/contracts/subagent";
import { buildSubagentResult, describeOutcome, MAX_RESULT_CHARS } from "./report-delivery";

function makeRun(patch: Partial<SubagentRun> = {}): SubagentRun {
  return {
    delegationId: "d-1",
    sessionId: "s-parent",
    parentToolCallId: "d-1",
    childSessionId: "child-1",
    agentName: "explorer",
    agentSource: "builtin",
    description: "调研重试逻辑",
    task: "看 src/retry.ts 的重试逻辑",
    status: "completed",
    startedAt: 1_000,
    model: null,
    modelId: "svc/model-x",
    thinkingLevel: "medium",
    turns: 4,
    toolCalls: 7,
    report: "重试上限是 3 次，见 src/retry.ts:42。",
    ...patch,
  };
}

describe("describeOutcome", () => {
  it("已完成：这是「xxx 已完成」那句话的来源，要带上子智能体名", () => {
    expect(describeOutcome(makeRun())).toContain("子智能体「explorer」已完成");
  });

  it("四种终态各有各的说法，不会被写成同一句", () => {
    const texts = (
      ["completed", "truncated", "interrupted", "aborted", "denied", "failed"] as const
    ).map((status) => describeOutcome(makeRun({ status })));
    // 每个状态都要有可辨识的说法：重复意味着界面分不清这几种结束
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("截断明确说「可能不完整」：模型不能把它当结论", () => {
    expect(describeOutcome(makeRun({ status: "truncated" }))).toContain("可能不完整");
  });

  it("失败与未能启动带上原因：模型据此判断要不要重派", () => {
    expect(describeOutcome(makeRun({ status: "failed", error: "模型返回错误" }))).toContain(
      "模型返回错误",
    );
    expect(describeOutcome(makeRun({ status: "denied", error: "请先配置模型服务" }))).toContain(
      "请先配置模型服务",
    );
  });
});

describe("buildSubagentResult", () => {
  it("running 不产出结果：还没跑完就不该盖上一个终态", () => {
    expect(buildSubagentResult(makeRun({ status: "running" }))).toBeNull();
  });

  it("已完成：状态 + 报告都在同一个结果里", () => {
    const result = buildSubagentResult(makeRun());
    expect(result).not.toBeNull();
    expect(result?.isError).toBe(false);
    // 「xxx 已完成」这个状态
    expect(result?.text).toContain("子智能体「explorer」已完成");
    // 报告就在这个状态里
    expect(result?.text).toContain("重试上限是 3 次");
  });

  it("告诉模型怎么再读一次，并要求它综合后转述", () => {
    const text = buildSubagentResult(makeRun())?.text ?? "";
    expect(text).toContain("TaskWait");
    expect(text).toContain("d-1");
    expect(text).toContain("不要原样转述");
  });

  it("没有报告时照样产出结果：状态本身就是要显示的东西", () => {
    const result = buildSubagentResult(makeRun({ report: undefined }));
    expect(result).not.toBeNull();
    expect(result?.text).toContain("没有产出报告");
    // 没有报告就不该给出「怎么再读一次」的提示（读也读不到东西）
    expect(result?.text).not.toContain("TaskWait");
  });

  it("空白报告等同于没有报告", () => {
    expect(buildSubagentResult(makeRun({ report: "  \n\t " }))?.text).toContain("没有产出报告");
  });

  it("失败与未能启动算失败（界面给红叉）", () => {
    expect(buildSubagentResult(makeRun({ status: "failed", report: "半截" }))?.isError).toBe(true);
    expect(buildSubagentResult(makeRun({ status: "denied" }))?.isError).toBe(true);
  });

  it("截断与停止不算失败：它们是「有结果的未完成」，不该给红叉", () => {
    expect(buildSubagentResult(makeRun({ status: "truncated" }))?.isError).toBe(false);
    expect(buildSubagentResult(makeRun({ status: "aborted" }))?.isError).toBe(false);
    expect(buildSubagentResult(makeRun({ status: "interrupted" }))?.isError).toBe(false);
  });

  it("意外终止也把报告带上：上个进程留下的结果仍然是结果", () => {
    const result = buildSubagentResult(makeRun({ status: "interrupted" }));
    expect(result?.text).toContain("意外终止");
    expect(result?.text).toContain("重试上限是 3 次");
  });

  it("超长报告被截断并写明原文长度，模型才知道不完整", () => {
    const long = "x".repeat(MAX_RESULT_CHARS + 500);
    const text = buildSubagentResult(makeRun({ report: long }))?.text ?? "";
    expect(text).toContain("报告已截断");
    expect(text).toContain(String(long.length));
    // 截断后的正文不该把整份原文再带一遍
    expect(text.length).toBeLessThan(long.length);
  });

  it("截断态的长报告：两份「不完整」都要说清（运行截断 + 报告截断）", () => {
    const text =
      buildSubagentResult(
        makeRun({ status: "truncated", report: "y".repeat(MAX_RESULT_CHARS + 10) }),
      )?.text ?? "";
    expect(text).toContain("可能不完整"); // 运行层面
    expect(text).toContain("报告已截断"); // 报告层面
  });
});
