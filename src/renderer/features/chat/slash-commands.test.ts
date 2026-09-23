/**
 * 斜杠命令纯逻辑的测试（node project）。
 *
 * 关键口径：模板**没有参数** —— 命令名之后多敲的文字按普通正文接在模板后面，
 * 正文里的 `$1` / `$ARGUMENTS` 只是普通字符，不做任何替换。
 *
 * 内置**指令**（`kind: "command"`）是另一回事：它由应用执行，参数原样交给指令自己解析
 * （见 dispatchSlashInput 的用例）。
 */

import { describe, expect, it } from "vitest";
import type { CommandSpec } from "@/shared/contracts/commands";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { SkillInfo } from "@/shared/contracts/skills";
import {
  buildSlashCommands,
  dispatchSlashInput,
  expandSlashInput,
  filterSlashCommands,
  insertSlashCommand,
  optionKey,
  parseSlashInvocation,
  type SlashCommand,
  slashQuery,
} from "./slash-commands";

function skill(name: string, description = ""): SkillInfo {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    source: "user",
    disabled: false,
  };
}

function template(name: string, content: string, description = ""): PromptTemplateInfo {
  return { name, description, content, source: "user", dir: "/prompts" };
}

function command(name: string): CommandSpec {
  return {
    id: "compact",
    name,
    descriptionKey: "chat.commandCompactDesc",
    hintKey: "chat.commandCompactHint",
    availability: "idle",
    argMode: "rest",
  };
}

/** 测试里的简写：默认「没有内置指令」；翻译用恒等函数（文案不是纯逻辑该管的事） */
function build(
  skills: readonly SkillInfo[],
  templates: readonly PromptTemplateInfo[],
  commands: readonly CommandSpec[] = [],
): SlashCommand[] {
  return buildSlashCommands(skills, templates, commands, (key) => key);
}

describe("buildSlashCommands", () => {
  it("三类都保留、同名不被吞掉，顺序是指令 → 技能 → 模板", () => {
    const commands = build([skill("review")], [template("review", "正文")], [command("review")]);
    expect(commands.map((c) => c.kind)).toEqual(["command", "skill", "template"]);
    expect(commands.every((c) => c.name === "review")).toBe(true);
  });

  it("指令的描述走语言包（描述 + 参数提示），技能与模板的正文各自保留", () => {
    const commands = build([skill("s")], [template("t", "模板正文")], [command("compact")]);
    expect(commands[0]?.description).toBe("chat.commandCompactDesc · chat.commandCompactHint");
    expect(commands[0]?.template).toBeUndefined();
    expect(commands[1]?.template).toBeUndefined();
    expect(commands[2]?.template).toBe("模板正文");
  });
});

describe("filterSlashCommands", () => {
  const commands = build([skill("review"), skill("commit")], [template("Translate", "x")]);

  it("空查询给出全量清单（菜单刚打开时）", () => {
    expect(filterSlashCommands(commands, "")).toHaveLength(3);
  });

  it("按名字前缀匹配且大小写不敏感", () => {
    expect(filterSlashCommands(commands, "re").map((c) => c.name)).toEqual(["review"]);
    expect(filterSlashCommands(commands, "tr").map((c) => c.name)).toEqual(["Translate"]);
    expect(filterSlashCommands(commands, "TR")).toHaveLength(1);
  });

  it("匹配不上返回空数组", () => {
    expect(filterSlashCommands(commands, "zzz")).toEqual([]);
  });

  it("不修改入参（返回新数组）", () => {
    const result = filterSlashCommands(commands, "");
    expect(result).not.toBe(commands);
  });
});

describe("slashQuery", () => {
  it("以 / 开头才算斜杠模式，名称即查询词", () => {
    expect(slashQuery("/")).toBe("");
    expect(slashQuery("/rev")).toBe("rev");
  });

  it("补全后的一个尾随空格仍然算（用户正接着往下写）", () => {
    expect(slashQuery("/review ")).toBe("review");
  });

  it("名称中间出现空格就退出斜杠模式（后面已经是用户正文）", () => {
    expect(slashQuery("/review file.ts")).toBeNull();
    // 多敲的空格只是尾随空白，查询词没变，菜单不该闪一下关掉
    expect(slashQuery("/review  ")).toBe("review");
  });

  it("不以 / 开头、或含换行都退出", () => {
    expect(slashQuery("hello")).toBeNull();
    expect(slashQuery("/re\nview")).toBeNull();
    expect(slashQuery("")).toBeNull();
  });
});

describe("parseSlashInvocation", () => {
  const commands = build([], [template("review", "x"), template("review-deep", "y")]);

  it("名字按最长匹配：/review-deep 不会被 /review 抢走，名字之后是用户正文", () => {
    const hit = parseSlashInvocation("/review-deep 看下 main.ts", commands);
    expect(hit?.command.name).toBe("review-deep");
    expect(hit?.rest).toBe("看下 main.ts");
  });

  it("只敲命令名时 rest 为空", () => {
    expect(parseSlashInvocation("/review", commands)?.rest).toBe("");
    expect(parseSlashInvocation("/review   ", commands)?.rest).toBe("");
  });

  it("命令名之后的文字原样保留（不拆词、不解释引号）", () => {
    expect(parseSlashInvocation('/review "a b" c', commands)?.rest).toBe('"a b" c');
  });

  it("认不出命令返回 null（用户可能就是想发一条以斜杠开头的消息）", () => {
    expect(parseSlashInvocation("/nope", commands)).toBeNull();
    expect(parseSlashInvocation("not a command", commands)).toBeNull();
    expect(parseSlashInvocation("/reviewer", commands)).toBeNull();
  });

  it("大小写不敏感：菜单按前缀小写匹配，发送时也必须认（否则「菜单里选得到、发送时没反应」）", () => {
    const mixed = build([], [template("Translate", "T")]);
    const hit = parseSlashInvocation("/translate 中文", mixed);
    expect(hit?.command.name).toBe("Translate");
    expect(hit?.rest).toBe("中文");
    // 反向亦然：命令是小写、用户敲大写
    expect(parseSlashInvocation("/REVIEW", commands)?.command.name).toBe("review");
  });

  it("名字后跟 tab 也算命令", () => {
    const hit = parseSlashInvocation("/review\thello", commands);
    expect(hit?.command.name).toBe("review");
    expect(hit?.rest).toBe("hello");
  });
});

describe("optionKey（菜单里一行的身份）", () => {
  it("同名技能与模板是两条不同的行", () => {
    const skillRow: SlashCommand = { kind: "skill", name: "review", description: "" };
    const templateRow: SlashCommand = {
      kind: "template",
      name: "review",
      description: "",
      template: "x",
    };
    expect(optionKey(skillRow)).not.toBe(optionKey(templateRow));
  });

  it("同 kind 同名稳定（可作为 React key 与 DOM id）", () => {
    const a: SlashCommand = { kind: "skill", name: "review", description: "" };
    expect(optionKey(a)).toBe(optionKey({ ...a }));
  });
});

describe("insertSlashCommand（菜单选中后填进输入框的内容）", () => {
  const templateCommand: SlashCommand = {
    kind: "template",
    name: "review",
    description: "",
    template: "Review carefully.",
  };

  it("技能只填 /name 加一个空格（正文在磁盘上，交给模型按需读）", () => {
    const command: SlashCommand = { kind: "skill", name: "review", description: "" };
    expect(insertSlashCommand(command)).toBe("/review ");
  });

  it("模板原样插入正文，用户接着往下写要处理的内容", () => {
    expect(insertSlashCommand(templateCommand)).toBe("Review carefully.");
  });

  it("指令与技能一样只填 /name 加空格：参数由用户接着敲，执行在发送时发生", () => {
    const command: SlashCommand = { kind: "command", name: "compact", description: "" };
    expect(insertSlashCommand(command)).toBe("/compact ");
  });
});

describe("expandSlashInput（发送前的展开）", () => {
  const commands = build([skill("commit")], [template("review", "Review carefully.", "看一遍")]);

  it("模板命令展开成正文", () => {
    expect(expandSlashInput("/review", commands)).toBe("Review carefully.");
  });

  it("命令名后面写的正文接在模板后面，空一行隔开（不丢用户输入）", () => {
    expect(expandSlashInput("/review main.ts", commands)).toBe("Review carefully.\n\nmain.ts");
  });

  it("正文里的 $1 / $ARGUMENTS 只是普通字符，不做替换", () => {
    const withPlaceholders = build([], [template("sh", "echo $1 $ARGUMENTS")]);
    expect(expandSlashInput("/sh 参数", withPlaceholders)).toBe("echo $1 $ARGUMENTS\n\n参数");
  });

  it("技能命令原样保留（正文不在渲染层）", () => {
    expect(expandSlashInput("/commit 整理提交", commands)).toBe("/commit 整理提交");
  });

  it("认不出来就原样返回，不吞用户输入", () => {
    expect(expandSlashInput("/not-a-command", commands)).toBe("/not-a-command");
    expect(expandSlashInput("普通消息", commands)).toBe("普通消息");
  });

  it("斜杠开头的普通消息不受影响", () => {
    expect(expandSlashInput("/usr/bin/env 是什么", commands)).toBe("/usr/bin/env 是什么");
  });
});

describe("dispatchSlashInput（发送前的唯一收口）", () => {
  const commands = build(
    [skill("commit")],
    [template("review", "Review carefully.")],
    [command("compact")],
  );

  it("指令被**认领**而不是展开成文本（发出去就变成一条普通消息了）", () => {
    const dispatch = dispatchSlashInput("/compact 保留数据库相关的讨论", commands);
    expect(dispatch).toEqual({
      kind: "command",
      command: { kind: "command", name: "compact", description: expect.any(String) },
      rest: "保留数据库相关的讨论",
    });
  });

  it("只敲命令名时参数为空串", () => {
    expect(dispatchSlashInput("/compact", commands)).toMatchObject({ kind: "command", rest: "" });
    expect(dispatchSlashInput("/compact   ", commands)).toMatchObject({
      kind: "command",
      rest: "",
    });
  });

  it("模板仍然展开成正文（与 expandSlashInput 同一结果）", () => {
    expect(dispatchSlashInput("/review main.ts", commands)).toEqual({
      kind: "message",
      text: "Review carefully.\n\nmain.ts",
    });
  });

  it("技能原样作为消息文本放行", () => {
    expect(dispatchSlashInput("/commit 整理提交", commands)).toEqual({
      kind: "message",
      text: "/commit 整理提交",
    });
  });

  it("认不出来的斜杠输入原样放行（用户可能就是想发一条以斜杠开头的消息）", () => {
    expect(dispatchSlashInput("/usr/bin/env 是什么", commands)).toEqual({
      kind: "message",
      text: "/usr/bin/env 是什么",
    });
    expect(dispatchSlashInput("普通消息", commands)).toEqual({
      kind: "message",
      text: "普通消息",
    });
  });

  it("没有内置指令时 /compact 退化成普通消息（不会凭空消失）", () => {
    expect(dispatchSlashInput("/compact", build([], []))).toEqual({
      kind: "message",
      text: "/compact",
    });
  });
});
