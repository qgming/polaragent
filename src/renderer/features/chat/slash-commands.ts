/**
 * 斜杠命令的**纯逻辑**：数据模型、过滤、解析、展开与派发。
 *
 * 为什么单独一个文件：菜单（SlashCommandMenu）与输入框（Composer）、以及发送收口
 * （OintRuntimeProvider）都要用它，而它自己不碰 React、不碰 IPC —— 因此能在 node project
 * 下直接喂普通对象做断言（与 TodoPanel 的 latestTodo 同一个口径）。
 *
 * 三类命令的分界只看**谁执行**：
 * - `command`（内置指令）：应用执行，整条命令不会变成模型消息（见 shared/contracts/commands）；
 * - `skill`（技能）：只有元数据，选中填 `/名称 `，正文留在磁盘上由模型按需读；
 * - `template`（魔法提示）：正文随列表下发，选中即展开成消息正文。
 *
 * 模板**没有参数**：魔法提示就是一段现成的提示词，选中（或敲 `/名称` 发送）时把正文原样
 * 作为消息内容；命令名之后多敲的文字按普通正文接在后面，不做任何占位符替换 ——
 * 正文里出现 `$1` 之类只是普通字符（写 shell 片段、价格时不会被吃掉）。
 * 指令的参数归**指令自己**解析（见 dispatchSlashInput 返回的 rest）。
 */

import type { CommandSpec } from "@/shared/contracts/commands";
import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { SkillInfo } from "@/shared/contracts/skills";

/**
 * 一条菜单项。
 *
 * 技能、模板与指令在菜单里分三栏，选中后的行为各不相同（见文件头）。
 * 用 kind 把差别显式化，而不是让菜单自己去看 name 撞没撞。
 */
export interface SlashCommand {
  kind: "command" | "skill" | "template";
  name: string;
  description: string;
  /** 仅模板有：正文，选中时用来展开（技能与指令没有正文，见上） */
  template?: string;
}

/**
 * 菜单里一行的身份：kind + name。
 *
 * 三类命令可以同名（分属三栏，都保留），只用 name 会让两条撞成同一个 DOM id、
 * 同时高亮，而且后一条永远选不中。
 */
export function optionKey(command: SlashCommand): string {
  return `${command.kind}/${command.name}`;
}

/** 菜单里三栏的顺序固定：指令在前（最"重"），技能居中，魔法提示最后 */
export const SLASH_GROUPS = ["command", "skill", "template"] as const;

/**
 * 把两个 IPC 列表与内置指令拍成一份菜单项。
 *
 * `translate` 只用在指令上：技能与模板的描述来自清单（磁盘上的原文），
 * 只有内置指令的摘要住在语言包里。传 `(key) => key` 也能用 —— 派发路径不需要文案。
 *
 * 同名的三类命令都保留（分属三栏），不在这里去重 —— 用户看得见它们的栏位，
 * 选哪个是明确的。
 */
export function buildSlashCommands(
  skills: readonly SkillInfo[],
  templates: readonly PromptTemplateInfo[],
  commands: readonly CommandSpec[],
  translate: (key: string) => string,
): SlashCommand[] {
  return [
    ...commands.map((command) => ({
      kind: "command" as const,
      name: command.name,
      description:
        command.hintKey === undefined
          ? translate(command.descriptionKey)
          : `${translate(command.descriptionKey)} · ${translate(command.hintKey)}`,
    })),
    ...skills.map((skill) => ({
      kind: "skill" as const,
      name: skill.name,
      description: skill.description,
    })),
    ...templates.map((template) => ({
      kind: "template" as const,
      name: template.name,
      description: template.description,
      template: template.content,
    })),
  ];
}

/** 名字前缀匹配（大小写不敏感）；空查询返回全部，菜单刚打开时就是全量清单 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  query: string,
): SlashCommand[] {
  const needle = query.toLowerCase();
  if (needle === "") return [...commands];
  return commands.filter((command) => command.name.toLowerCase().startsWith(needle));
}

/**
 * 按栏归并后的线性顺序：技能整栏在前、模板整栏在后。
 *
 * 菜单照它渲染、Composer 的上下键照它走位 —— 两处必须是同一个顺序，否则高亮会在
 * 两栏之间乱跳。所以排序只此一份。
 */
export function orderSlashCommands(commands: readonly SlashCommand[]): SlashCommand[] {
  return SLASH_GROUPS.flatMap((kind) => commands.filter((command) => command.kind === kind));
}

/**
 * 输入框文本是不是一条正在敲的斜杠命令。
 *
 * 只认「整段以 `/` 开头，且名称部分里没有空白」—— 空格或 tab 一出现，名称之后已经是用户
 * 自己补的正文，此时该收起菜单：再收窄列表只会挡住刚敲的内容。尾随空白不算数
 *（菜单补全后就是 `/name `，用户正接着往下写）。
 *
 * 返回的查询词保持用户**原始大小写**（只是过滤时折成小写比较），这样清单里显示的仍是
 * 命令的规范名。
 */
export function slashQuery(value: string): string | null {
  if (!value.startsWith("/")) return null;
  const name = value.slice(1).trimEnd();
  if (/[\s]/.test(name)) return null;
  return name;
}

/** parseSlashInvocation 的结果：认到的命令 + 名称之后剩下的正文 */
export interface SlashInvocation {
  command: SlashCommand;
  /** 命令名之后用户多敲的文字（首尾空白已去掉；没有就是空串） */
  rest: string;
}

/**
 * 从「`/name` + 正文」里认出命令。
 *
 * 两条口径都与菜单保持严格一致，否则会出现「菜单里选得到、发送时却认不出来」：
 * - **大小写不敏感**：菜单按前缀小写匹配，用户敲 `/translate` 时命中的可能就是
 *   `Translate.md`；这里若严格比大小写，发送时就不认了。
 * - 名字后既可以跟空格也可以跟 tab。
 * - 名字按**最长**匹配：`/review-deep` 不会被 `/review` 抢走。
 *
 * 匹配不上时返回 null，调用方据此保持原文不动（用户可能就是想发一条以斜杠开头的消息）。
 */
export function parseSlashInvocation(
  value: string,
  commands: readonly SlashCommand[],
): SlashInvocation | null {
  if (!value.startsWith("/")) return null;
  const body = value.slice(1);
  const lowered = body.toLowerCase();
  let best: SlashCommand | null = null;
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const follows = lowered[name.length];
    // 名字后面必须是结尾、空格或 tab —— 否则 `/reviewer` 会把 `/review` 认成命中
    if (
      !lowered.startsWith(name) ||
      (follows !== undefined && follows !== " " && follows !== "\t")
    ) {
      continue;
    }
    if (best === null || command.name.length > best.name.length) best = command;
  }
  if (best === null) return null;
  // 名称之后剩下的都是用户的正文，原样保留（不拆词、不解释引号）
  return { command: best, rest: body.slice(best.name.length).trim() };
}

/**
 * 菜单里选中一条命令后，输入框该变成什么。
 *
 * 技能与指令都只有元数据（指令的执行由发送路径认领），填 `/name `（尾随空格让人直接接着
 * 敲参数或说明）；模板的正文已经在手上，直接原样插入。
 */
export function insertSlashCommand(command: SlashCommand): string {
  if (command.kind !== "template" || command.template === undefined) return `/${command.name} `;
  return command.template;
}

/**
 * 发送前的展开：输入框里是一条完整的斜杠命令时，把它换成真正发给模型的内容。
 *
 * 模板 → 正文原样发出；命令名之后多敲的文字接在正文后面（空一行隔开），不丢用户输入。
 * 技能 → `/name 说明` 原样保留（正文在磁盘上，由模型自己按需读，展开成别的东西反而与
 * 它看到的一致）。指令 → 原样返回（它**不该走到这里**，见 dispatchSlashInput）。
 * 认不出来就原样返回，绝不在这里吞掉用户输入。
 */
export function expandSlashInput(value: string, commands: readonly SlashCommand[]): string {
  const invocation = parseSlashInvocation(value, commands);
  if (invocation === null) return value;
  const { command, rest } = invocation;
  if (command.kind !== "template" || command.template === undefined) return value;
  return rest === "" ? command.template : `${command.template}\n\n${rest}`;
}

/**
 * 发送前派发的结果。
 *
 * 为什么要和 `expandSlashInput` 分开：那个函数只回答「展开成什么文本」，而指令根本
 * **不该变成文本**。把「认领」这一步显式化，调用方就必须处理 `command` 分支 ——
 * 否则一条 `/compact` 会被当成普通消息发出去。
 */
export type SlashDispatch =
  | { kind: "message"; text: string }
  | { kind: "command"; command: SlashCommand; rest: string };

/**
 * 发送前的**唯一收口**：认出指令、展开模板、放行普通消息。
 *
 * 技能不认领（它就是要发出去的文本：`/名称 说明`），只有 `kind === "command"` 才拦截。
 */
export function dispatchSlashInput(
  value: string,
  commands: readonly SlashCommand[],
): SlashDispatch {
  const invocation = parseSlashInvocation(value, commands);
  if (invocation === null) return { kind: "message", text: value };
  if (invocation.command.kind === "command") {
    return { kind: "command", command: invocation.command, rest: invocation.rest };
  }
  return { kind: "message", text: expandSlashInput(value, commands) };
}
