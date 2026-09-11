// 会话命名提示词：内置英文模板、素材注入、以及「标题语言跟随用户消息」这条规则的存在性。
import { describe, expect, it } from "vitest";
import {
  buildSessionTitlePrompt,
  SESSION_TITLE_PROMPT,
  SESSION_TITLE_SYSTEM_PROMPT,
} from "./session-title";

describe("buildSessionTitlePrompt", () => {
  it("把用户消息与助手回复填进占位符，不再残留占位符", () => {
    const prompt = buildSessionTitlePrompt({
      userText: "帮我修一下登录超时",
      assistantText: "问题在超时配置",
    });
    expect(prompt).toContain("帮我修一下登录超时");
    expect(prompt).toContain("问题在超时配置");
    expect(prompt).not.toContain("{{");
  });

  it("钉死输出形状：只要一个含 title 的 JSON 对象", () => {
    const prompt = buildSessionTitlePrompt({ userText: "u", assistantText: "a" });
    expect(prompt).toContain("Return exactly one JSON object and nothing else");
    expect(prompt).toContain('{"title": string}');
  });

  it("要求标题语言与用户消息一致", () => {
    expect(SESSION_TITLE_PROMPT).toContain("same language as the user's message");
    expect(SESSION_TITLE_PROMPT.toLowerCase()).toContain("chinese message gets a chinese title");
  });

  it("要求标题具体、简短，并禁止把对话本身写进标题", () => {
    expect(SESSION_TITLE_PROMPT).toContain("never a generic label");
    expect(SESSION_TITLE_PROMPT).toContain("at most 8 words");
    expect(SESSION_TITLE_PROMPT).toContain('no "User asks"');
  });

  it("系统提示词说明角色", () => {
    expect(SESSION_TITLE_SYSTEM_PROMPT).toContain("Oint");
  });
});
