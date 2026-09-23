// subagent-prompt 的单测：索引与路由段的形状、边界与「不互相包含」这条分工。
//
// 为什么值得单独钉：这两段文本是「模型知不知道能派谁、该不该派」的唯一来源，
// 而它们的错误方式都是**静默**的 —— 索引少了名字，模型只是永远不派它；
// 路由段混进了名录，就多了一个会与索引漂移的副本。两种都不会有任何报错。

import { describe, expect, it } from "vitest";
import type { SubagentDefinition } from "@/shared/contracts/subagent";
import { BUILTIN_SUBAGENTS } from "./subagent-catalog";
import {
  buildDelegationPrompt,
  buildSubagentSystemPrompt,
  formatSubagentsForSystemPrompt,
} from "./subagent-prompt";

function def(overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    name: "helper",
    description: "做一件事",
    prompt: "你是子智能体。",
    source: "user",
    ...overrides,
  };
}

describe("formatSubagentsForSystemPrompt", () => {
  it("生成 <available_subagents> 索引，每项带名字、描述与来源", () => {
    const text = formatSubagentsForSystemPrompt([def({ source: "builtin" })]);

    expect(text).toContain("<available_subagents>");
    expect(text).toContain("</available_subagents>");
    expect(text).toContain("<name>helper</name>");
    expect(text).toContain("<description>做一件事</description>");
    expect(text).toContain("<source>builtin</source>");
  });

  /**
   * 索引里**不再有 <tools> 段**：子智能体拿到的是主代理同一批工具（唯一例外是不能委派），
   * 那是所有子智能体共享的一条规则，写进索引就是 N 份重复 —— 而索引每轮都付 token。
   */
  it("索引里不列工具（工具对所有子智能体都一样，不属于每条定义）", () => {
    const text = formatSubagentsForSystemPrompt([def({ source: "builtin" })]);

    expect(text).not.toContain("<tools>");
    expect(text).not.toContain("disabled_tools");
  });

  it("没有可用定义时返回空串（一份空索引会让模型反复尝试派发）", () => {
    expect(formatSubagentsForSystemPrompt([])).toBe("");
  });

  it("用户自定义的定义也进索引：这正是通用模式下模型唯一的来源", () => {
    // 内置那些可以从 Task 的描述里看到，用户自定义的只在数据目录里 ——
    // 通用模式不写委派段，所以索引是它唯一能知道有这些定义的地方
    const text = formatSubagentsForSystemPrompt([
      def({ name: "my-auditor", source: "user" }),
      def({ name: "explorer", source: "builtin" }),
    ]);

    expect(text).toContain("<name>my-auditor</name>");
    expect(text).toContain("<name>explorer</name>");
  });

  it("超过上限时截断，并说明还剩多少个（而不是静默少列）", () => {
    const many = Array.from({ length: 20 }, (_, index) => def({ name: `agent-${index}` }));
    const text = formatSubagentsForSystemPrompt(many);

    expect(text).toContain("<name>agent-0</name>");
    expect(text).toContain("<name>agent-11</name>");
    expect(text).not.toContain("<name>agent-12</name>");
    expect(text).toContain("还有 8 个");
  });

  it("名字或描述里的尖括号被转义：它们是用户可写的，直接插会破坏结构", () => {
    const text = formatSubagentsForSystemPrompt([
      def({ name: "a", description: "看 <html> & 'quotes'" }),
    ]);

    expect(text).toContain("&lt;html&gt;");
    expect(text).toContain("&amp;");
    expect(text).not.toContain("<html>");
  });

  it("七个内置全部出现在索引里（且列得下，不触发截断）", () => {
    const text = formatSubagentsForSystemPrompt(BUILTIN_SUBAGENTS);

    for (const builtin of BUILTIN_SUBAGENTS) {
      expect(text).toContain(`<name>${builtin.name}</name>`);
    }
    expect(text).not.toContain("还有");
  });
});

describe("buildDelegationPrompt", () => {
  it("没有可用定义时返回空串", () => {
    expect(buildDelegationPrompt([], "m1")).toBe("");
  });

  /**
   * 索引与路由段的**分工**：索引是目录，路由段是策略。
   * 路由段**不再重复列名录** —— 那会变成同一事实的两个来源，两处必然漂移。
   */
  it("不再重复列名录，只指向索引", () => {
    const text = buildDelegationPrompt(BUILTIN_SUBAGENTS, "m1");

    expect(text).toContain("<available_subagents>");
    for (const builtin of BUILTIN_SUBAGENTS) {
      expect(text).not.toContain(builtin.description);
    }
  });

  /**
   * 分工：**每个子智能体的路由判据在索引里**（它那一条 description），
   * **横跨所有子智能体的纪律在本段**。
   *
   * 这条分工值得钉住，因为它省掉了一整块重复：把「explorer 什么时候该派」写在两处，
   * 早晚会漂移；写在 description 里则两处（索引与路由判据）本来就是同一份文本。
   */
  it("委派本段讲的是跨子智能体的纪律，而不是逐个讲解该派谁", () => {
    const text = buildDelegationPrompt(BUILTIN_SUBAGENTS, "m1");

    // 指路：告诉模型去索引里看每个子智能体的判据
    expect(text).toContain("什么时候该派");
    expect(text).toContain("<available_subagents>");

    // 跨子智能体的纪律（本段的职责）
    expect(text).toContain("自包含");
    expect(text).toContain("两个能改文件的子智能体不要同时改同一批文件");
    expect(text).toContain("不要用 TaskStop");
  });

  it("两面都点明：既不要「因为有专家就派」，也不要「每步都不难就全自己做」", () => {
    const text = buildDelegationPrompt(BUILTIN_SUBAGENTS, "m1");

    // 两个方向的误用都要写：只写一面会让模型倒向另一面
    expect(text).toContain("不要因为「有这个专家」就派");
    expect(text).toContain("也不要因为「每一步都不难」就全自己做");
  });

  it("点明「完成不等于结论正确」：验收要靠自己读一遍改动", () => {
    const text = buildDelegationPrompt(BUILTIN_SUBAGENTS, "m1");

    expect(text).toContain("不等于");
    expect(text).toContain("read");
  });

  it("带上主会话模型名（子智能体默认继承它）", () => {
    expect(buildDelegationPrompt(BUILTIN_SUBAGENTS, "svc/model-x")).toContain("svc/model-x");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("框定身份：看不到用户、不能提问、不能再委派", () => {
    const text = buildSubagentSystemPrompt(def(), "/w");

    expect(text).toContain("/w");
    expect(text).toContain("看不到用户");
    expect(text).toContain("不能再委派");
  });

  /**
   * 工具与主代理一致这件事要**明说**：否则子智能体会沿用旧印象
   *（"我是子智能体，大概只有只读工具"）而不敢跑命令、不敢验证 ——
   * 那正是这次改动要修掉的行为。
   */
  it("明说工具与主代理完全一致，并鼓励动手验证", () => {
    const text = buildSubagentSystemPrompt(def(), "/w");

    expect(text).toContain("完全一致");
    expect(text).toContain("该跑的命令要跑");
  });

  it("允许改文件但限定范围", () => {
    const text = buildSubagentSystemPrompt(def(), "/w");

    expect(text).toContain("可以修改文件");
    expect(text).toContain("只改任务真正涉及的那些");
  });

  it("定义正文原样接在后面，最后一条消息即报告", () => {
    const text = buildSubagentSystemPrompt(def({ prompt: "只在沙漠里找水。" }), "/w");

    expect(text).toContain("只在沙漠里找水。");
    expect(text).toContain("最后一条消息");
  });
});
