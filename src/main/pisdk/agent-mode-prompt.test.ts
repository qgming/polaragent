// 两个模式的身份段与「路由段该不该注入」的单测。
//
// 这一层的错误方式也是静默的：两个模式的文案要是一样，用户切了模式什么都不会变，
// 而且没有任何报错 —— 所以这里断言的是**两者必须不同**，以及各自的要点必须在。

import { describe, expect, it } from "vitest";
import { AGENT_MODES, type AgentMode } from "@/shared/contracts/common";
import { agentModeSection, shouldIncludeDelegationRules } from "./agent-mode-prompt";

function section(mode: AgentMode, language: "zh-CN" | "en-US" = "zh-CN"): string {
  return agentModeSection(mode, language);
}

describe("两个模式的身份段", () => {
  it("**必须不一样**：一样的话切模式就等于没切", () => {
    const standard = section("standard");
    const orchestrate = section("orchestrate");

    expect(standard).not.toBe(orchestrate);
    expect(standard.length).toBeGreaterThan(200);
    expect(orchestrate.length).toBeGreaterThan(200);
  });

  it("每个模式都有身份句与回复语言要求", () => {
    for (const mode of AGENT_MODES) {
      const text = section(mode);
      expect(text).toContain("Oint");
      expect(text).toContain("使用简体中文回复用户");
    }
    expect(section("standard", "en-US")).toContain("使用英文回复用户");
  });

  it("cwd 留成占位符，由调用方渲染（模板只管措辞，不做拼接）", () => {
    for (const mode of AGENT_MODES) {
      expect(section(mode)).toContain("{{cwd}}");
    }
  });
});

describe("standard 模式", () => {
  it("是**通用**助手，不是编程助手 —— 并且显式要求先判断任务类型", () => {
    const text = section("standard");

    expect(text).toContain("通用助手");
    expect(text).toContain("先判断这是什么任务");
    // 旧提示的第一句是「智能编程助手」，那会把写作/调研类任务也按改代码的习惯处理
    expect(text).not.toContain("编程助手");
  });

  it("列出非编程的任务类型（这是「通用」的实质，不是修辞）", () => {
    const text = section("standard");

    expect(text).toContain("写作与文档");
    expect(text).toContain("调研与综合");
    expect(text).toContain("规划与拆解");
  });

  it("保留「什么时候该问」的纪律（含「先搜再问」与「无人值守不要卡住」）", () => {
    const text = section("standard");

    expect(text).toContain("先搜再问");
    expect(text).toContain("无人值守");
    expect(text).toContain("每轮最多问一个问题");
  });

  it("保留既有测试依赖的两个子串（工具指导段与回复语言）", () => {
    const text = section("standard");

    // 这两条是 runtime.test.ts 里既有断言的基础，改名会让它们无声地失去覆盖
    expect(text).toContain("怎么工作");
    expect(text).toContain("使用简体中文回复用户");
  });
});

describe("orchestrate 模式", () => {
  it("身份是编排者，且**默认不自己动手**", () => {
    const text = section("orchestrate");

    expect(text).toContain("编排者");
    // 没有这句，模型会把「编排者」当成一个头衔然后照旧自己改代码
    expect(text).toContain("先");
    expect(text).toContain("派");
  });

  it("说明「什么时候才自己动手」，避免变成什么都不敢做", () => {
    const text = section("orchestrate");

    expect(text).toContain("自己");
    expect(text).toContain("派发");
  });

  it("不重复委派路由段的内容（两段分工：这里说身份，那边说策略）", () => {
    // 路由段的标题只应出现在 buildDelegationPrompt 里
    expect(section("orchestrate")).not.toContain("## 委派（子智能体）");
  });
});

/**
 * 交叉引用不能悬空。
 *
 * 这条测试是有来历的：编排段曾经写着「含糊时先问一个能改变做法的问题（**见「怎么问」**）」，
 * 但「怎么问」那一节当时只写在**智能体模式**里 —— 于是编排者模式下这句话指向一个
 * 不存在的章节，模型读到的是一句悬空的指路，而且不会有任何报错。
 *
 * 光断言「提到了怎么问」不够（那种断言当时也能过），要断言**被引用的那一节真的在**。
 */
describe("章节完整性", () => {
  it("两个模式都有「怎么问」这一节（编排段会引用它）", () => {
    for (const mode of AGENT_MODES) {
      expect(section(mode)).toContain("## 怎么问");
    }
  });

  it("正文里提到的章节标题都真的存在于同一段提示里", () => {
    for (const mode of AGENT_MODES) {
      const text = section(mode);
      // 提示里用「见「xxx」」的形式做内部交叉引用
      const referenced = [...text.matchAll(/见「([^」]+)」/g)].map((match) => match[1] ?? "");
      for (const name of referenced) {
        expect(text).toContain(`## ${name}`);
      }
    }
  });

  it("两个模式都保留提问纪律的要点（共用块，不是各写一份）", () => {
    for (const mode of AGENT_MODES) {
      const text = section(mode);
      expect(text).toContain("每轮最多问一个问题");
      expect(text).toContain("无人值守");
    }
  });
});

describe("shouldIncludeDelegationRules", () => {
  it("只有编排者模式注入委派路由段", () => {
    expect(shouldIncludeDelegationRules("orchestrate")).toBe(true);
    expect(shouldIncludeDelegationRules("standard")).toBe(false);
  });

  it("对每个已知模式都有明确答案（加模式时这里会提醒你想清楚）", () => {
    for (const mode of AGENT_MODES) {
      expect(typeof shouldIncludeDelegationRules(mode)).toBe("boolean");
    }
  });
});
