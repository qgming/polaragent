/**
 * 斜杠命令纯逻辑的测试（node project）。
 *
 * 这里同时承担一个「咬住内核口径」的职责：substituteSlashArgs / parseSlashArgs 是照抄
 * @earendil-works/pi-agent-core 的实现（见 slash-commands.ts 头注释），断言即抄自内核
 * dist/harness/prompt-templates.js 的行为。内核哪天改了语义，这里会先红。
 */

import { describe, expect, it } from "vitest";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { SkillInfo } from "@/shared/contracts/skills";
import {
  buildSlashCommands,
  expandSlashInput,
  filterSlashCommands,
  insertSlashCommand,
  optionKey,
  parseSlashArgs,
  parseSlashInvocation,
  type SlashCommand,
  slashQuery,
  substituteSlashArgs,
} from "./slash-commands";

function skill(name: string, description = ""): SkillInfo {
  return {
    name,
    description,
    filePath: `/skills/${name}/SKILL.md`,
    source: "global",
    disabled: false,
  };
}

function template(name: string, content: string, description = ""): PromptTemplateInfo {
  return { name, description, content, source: "global", dir: "/prompts" };
}

describe("buildSlashCommands", () => {
  it("技能在前、模板在后，且同名不会被吞掉", () => {
    const commands = buildSlashCommands([skill("review")], [template("review", "正文")]);
    expect(commands.map((c) => c.kind)).toEqual(["skill", "template"]);
    expect(commands.every((c) => c.name === "review")).toBe(true);
  });

  it("模板带上正文，技能没有正文", () => {
    const commands = buildSlashCommands([skill("s")], [template("t", "模板正文")]);
    expect(commands[0]?.template).toBeUndefined();
    expect(commands[1]?.template).toBe("模板正文");
  });
});

describe("filterSlashCommands", () => {
  const commands = buildSlashCommands(
    [skill("review"), skill("commit")],
    [template("Translate", "x")],
  );

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

  it("补全后的一个尾随空格仍然算（用户正接着敲参数）", () => {
    expect(slashQuery("/review ")).toBe("review");
  });

  it("名称中间出现空格就退出斜杠模式（参数已经开始）", () => {
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

describe("parseSlashArgs（口径抄自内核 parseCommandArgs）", () => {
  it("空格与 tab 分隔", () => {
    expect(parseSlashArgs("a\tb c")).toEqual(["a", "b", "c"]);
  });

  it("单双引号成组", () => {
    expect(parseSlashArgs("one \"two three\" 'four five'")).toEqual([
      "one",
      "two three",
      "four five",
    ]);
  });

  it("空引号串被丢弃", () => {
    expect(parseSlashArgs('a "" b')).toEqual(["a", "b"]);
  });

  it("反斜杠是普通字符（内核不处理转义）", () => {
    expect(parseSlashArgs("a\\ b")).toEqual(["a\\", "b"]);
  });
});

describe("substituteSlashArgs（口径抄自内核 substituteArgs）", () => {
  it("$1/$2 按位置替换，缺参补空串", () => {
    expect(substituteSlashArgs("$1-$2-$3", ["a"])).toBe("a--");
  });

  it("$ARGUMENTS 与 $@ 都是全部参数空格连接", () => {
    expect(substituteSlashArgs("[$ARGUMENTS]", ["a", "b"])).toBe("[a b]");
    expect(substituteSlashArgs("[$@]", ["a", "b"])).toBe("[a b]");
  });

  it("切片占位符：取第 N 个起，以及从 N 起取 L 个", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 内核的占位符字面量，不是漏写的模板串
    const sliceFrom = "${@:2}";
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 内核的占位符字面量，不是漏写的模板串
    const sliceRange = "${@:2:1}";
    expect(substituteSlashArgs(sliceFrom, ["a", "b", "c"])).toBe("b c");
    expect(substituteSlashArgs(sliceRange, ["a", "b", "c"])).toBe("b");
  });

  it("替换顺序固定：$1 先于 $@，因此 $1 的结果不会被 $@ 二次改写", () => {
    expect(substituteSlashArgs("$1 $@", ["a", "b"])).toBe("a a b");
  });
});

describe("parseSlashInvocation", () => {
  const commands = buildSlashCommands([], [template("review", "x"), template("review-deep", "y")]);

  it("名字按最长匹配：/review-deep 不会被 /review 抢走", () => {
    const hit = parseSlashInvocation("/review-deep a", commands);
    expect(hit?.command.name).toBe("review-deep");
    expect(hit?.args).toEqual(["a"]);
  });

  it("无参数时 args 为空", () => {
    expect(parseSlashInvocation("/review", commands)?.args).toEqual([]);
  });

  it("参数支持引号成组", () => {
    expect(parseSlashInvocation('/review "a b" c', commands)?.args).toEqual(["a b", "c"]);
  });

  it("认不出命令返回 null（用户可能就是想发一条以斜杠开头的消息）", () => {
    expect(parseSlashInvocation("/nope", commands)).toBeNull();
    expect(parseSlashInvocation("not a command", commands)).toBeNull();
    expect(parseSlashInvocation("/reviewer", commands)).toBeNull();
  });

  it("大小写不敏感：菜单按前缀小写匹配，发送时也必须认（否则「菜单里选得到、发送时没反应」）", () => {
    const mixed = buildSlashCommands([], [template("Translate", "T $1")]);
    const hit = parseSlashInvocation("/translate 中文", mixed);
    expect(hit?.command.name).toBe("Translate");
    expect(hit?.args).toEqual(["中文"]);
    // 反向亦然：命令是小写、用户敲大写
    expect(parseSlashInvocation("/REVIEW", commands)?.command.name).toBe("review");
  });

  it("名字后跟 tab 也算命令（内核把 tab 当分隔符）", () => {
    const hit = parseSlashInvocation("/review\thello", commands);
    expect(hit?.command.name).toBe("review");
    expect(hit?.args).toEqual(["hello"]);
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
    template: "Review $1 carefully.",
  };

  it("技能只填 /name 加一个空格（正文在磁盘上，交给模型按需读）", () => {
    const command: SlashCommand = { kind: "skill", name: "review", description: "" };
    expect(insertSlashCommand(command)).toBe("/review ");
  });

  it("模板在没敲参数时原样插入正文：占位符留在眼前，用户看得见要填哪里", () => {
    expect(insertSlashCommand(templateCommand)).toBe("Review $1 carefully.");
  });

  it("带参数时直接展开", () => {
    expect(insertSlashCommand(templateCommand, ["main.ts"])).toBe("Review main.ts carefully.");
  });
});

describe("expandSlashInput（发送前的展开）", () => {
  const commands = buildSlashCommands(
    [skill("commit")],
    [template("review", "Review $1 carefully.", "看一遍")],
  );

  it("模板命令展开成替换后的正文", () => {
    expect(expandSlashInput("/review main.ts", commands)).toBe("Review main.ts carefully.");
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
