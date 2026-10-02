/**
 * 新会话页「起手提示」的挑选逻辑（node project：这里没有 React，也没有 IPC）。
 *
 * 这一排 chip 的内容来自磁盘上的模板，而模板是按名字扫出来的 —— 顺序不由我们定。
 * 所以「挑哪几条、按什么顺序」是一件必须钉住的纯逻辑，否则同一份模板在不同机器上
 * 会排出不同的 chip，看起来像「功能时好时坏」。
 */

import { describe, expect, it } from "vitest";
import type { SlashCommand } from "./slash-commands";
import { pickStarterPrompts, STARTER_PROMPT_LIMIT } from "./starter-prompts";

function template(name: string): SlashCommand {
  return { kind: "template", name, description: `${name} 说明`, template: `${name} 正文` };
}

describe("pickStarterPrompts", () => {
  it("按固定优先级排，而不是按清单顺序", () => {
    const picked = pickStarterPrompts([template("commit"), template("plan"), template("debug")]);

    expect(picked.map((item) => item.command.name)).toEqual(["plan", "debug", "commit"]);
  });

  it("每一条都带自己的短标签（chip 上显示的是它，不是模板名）", () => {
    const picked = pickStarterPrompts([template("plan")]);

    expect(picked[0]?.labelKey).toBe("chat.promptPlan");
  });

  it("只取模板：同名技能与内置指令都不进这一排", () => {
    const commands: SlashCommand[] = [
      { kind: "command", name: "compact", description: "压缩上下文" },
      { kind: "skill", name: "plan", description: "技能也叫 plan" },
      template("plan"),
    ];

    const picked = pickStarterPrompts(commands);

    expect(picked.map((item) => item.command.name)).toEqual(["plan"]);
    expect(picked[0]?.command.kind).toBe("template");
  });

  it("最多四条：再多会换行，而这一排只负责「一眼扫过」", () => {
    const all = ["plan", "debug", "review", "verify", "commit", "map"].map(template);

    expect(pickStarterPrompts(all)).toHaveLength(STARTER_PROMPT_LIMIT);
  });

  it("名单之外的模板不进 chip（它们仍然在斜杠菜单里，一条不少）", () => {
    expect(pickStarterPrompts([template("translate")])).toEqual([]);
  });

  it("名字大小写不敏感：模板名来自磁盘，比较口径与斜杠菜单一致", () => {
    expect(pickStarterPrompts([template("Plan")]).map((item) => item.command.name)).toEqual([
      "Plan",
    ]);
  });

  it("没有模板时返回空数组（调用方据此整排不渲染）", () => {
    expect(pickStarterPrompts([])).toEqual([]);
  });
});
