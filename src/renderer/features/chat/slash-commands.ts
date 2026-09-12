/**
 * 斜杠命令的**纯逻辑**：数据模型、过滤、解析与展开。
 *
 * 为什么单独一个文件：菜单（SlashCommandMenu）与输入框（Composer）都要用它，而它自己不碰
 * React、不碰 IPC —— 因此能在 node project 下直接喂普通对象做断言（与 TodoPanel 的
 * latestTodo 同一个口径）。
 *
 * 两处口径刻意与内核对齐，改动前先看内核实现：
 * - 模板正文的占位符替换语义（`$1`/`$@`/`$ARGUMENTS`/`${@:N}`/`${@:N:L}`）照抄
 *   `@earendil-works/pi-agent-core` 的 substituteArgs。内核整个包根会连带 ignore / yaml /
 *   typebox 等重依赖，渲染层不 import 它，这里自己写一份并逐条测住。
 * - 参数解析同理照抄内核的 parseCommandArgs（shell 风格单双引号、空格或 tab 分隔、无转义、
 *   空引号串丢弃）。
 */

import type { PromptTemplateInfo } from "@/shared/contracts/prompts";
import type { SkillInfo } from "@/shared/contracts/skills";

/**
 * 一条菜单项。
 *
 * 技能与模板在菜单里是两栏，选中后的行为却不同：
 * - 技能只有元数据（正文留在磁盘上，由模型按需读），所以只能把 `/name` 填进输入框；
 * - 模板的正文随列表一起下发，所以选中即可展开成最终正文。
 * 用 kind 把这条差别显式化，而不是让菜单自己去看 name 撞没撞。
 */
export interface SlashCommand {
  kind: "skill" | "template";
  name: string;
  description: string;
  /** 仅模板有：正文，选中时用来展开（技能没有正文，见上） */
  template?: string;
}

/**
 * 菜单里一行的身份：kind + name。
 *
 * 技能与提示模板可以同名（分属两栏，都保留），只用 name 会让两条撞成同一个 DOM id、
 * 同时高亮，而且后一条永远选不中。
 */
export function optionKey(command: SlashCommand): string {
  return `${command.kind}/${command.name}`;
}

/** 菜单里两栏的顺序固定：技能在前、提示模板在后 */
export const SLASH_GROUPS = ["skill", "template"] as const;

/**
 * 把两个 IPC 列表拍成一份菜单项。
 *
 * 同名的技能与模板都保留（分属两栏），不在这里去重 —— 用户看得见它们的栏位，
 * 选哪个是明确的。
 */
export function buildSlashCommands(
  skills: readonly SkillInfo[],
  templates: readonly PromptTemplateInfo[],
): SlashCommand[] {
  return [
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
 * 只认「整段以 `/` 开头，且名称部分里没有空白」—— 空格或 tab 一出现，参数已经开始，
 * 此时该收起菜单：再收窄列表只会挡住用户刚敲的参数。尾随空白不算数（菜单补全后就是
 * `/name `，用户正接着敲参数）。
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

/** parseSlashInvocation 的结果：认到的命令 + 拆好的参数 */
export interface SlashInvocation {
  command: SlashCommand;
  args: readonly string[];
}

/**
 * 从「`/name` + 参数」里认出命令并拆出参数。
 *
 * 两条口径都与菜单保持严格一致，否则会出现「菜单里选得到、发送时却认不出来」：
 * - **大小写不敏感**：菜单按前缀小写匹配，用户敲 `/translate` 时命中的可能就是
 *   `Translate.md`；这里若严格比大小写，发送时就不认了。
 * - 名字后既可以跟空格也可以跟 tab（内核的 parseCommandArgs 也把 tab 当分隔符）。
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
  // 参数按**命令规范名**的长度切，而不是小写化之后的（长度相同，但这里表达的是同一个偏移）
  return { command: best, args: parseSlashArgs(body.slice(best.name.length).trim()) };
}

/** 照抄内核 parseCommandArgs：单双引号成组，空格或 tab 分隔，反斜杠是普通字符，空引号串丢弃 */
export function parseSlashArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of input) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === " " || char === "\t") {
      if (current !== "") {
        args.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current !== "") args.push(current);
  return args;
}

/** 照抄内核 substituteArgs；替换顺序固定（`$1` → `${@:N}` → `$ARGUMENTS` → `$@`），不能重排 */
export function substituteSlashArgs(content: string, args: readonly string[]): string {
  let result = content;
  result = result.replace(/\$(\d+)/g, (_, num: string) => args[Number.parseInt(num, 10) - 1] ?? "");
  result = result.replace(
    /\$\{@:(\d+)(?::(\d+))?\}/g,
    (_, startStr: string, lengthStr?: string) => {
      const start = Math.max(0, Number.parseInt(startStr, 10) - 1);
      if (lengthStr !== undefined) {
        return args.slice(start, start + Number.parseInt(lengthStr, 10)).join(" ");
      }
      return args.slice(start).join(" ");
    },
  );
  const all = args.join(" ");
  result = result.replace(/\$ARGUMENTS/g, all);
  result = result.replace(/\$@/g, all);
  return result;
}

/**
 * 菜单里选中一条命令后，输入框该变成什么。
 *
 * 技能：只有元数据，填 `/name `（尾随空格让人直接接着敲说明）。
 * 模板：正文已经在手上，直接展开；此时还没敲参数，就原样插入带占位符的正文 ——
 * 占位符留在眼前比替成空串更有用，用户看得见要填哪几个位置。
 */
export function insertSlashCommand(command: SlashCommand, args: readonly string[] = []): string {
  if (command.kind === "skill" || command.template === undefined) return `/${command.name} `;
  return args.length === 0 ? command.template : substituteSlashArgs(command.template, args);
}

/**
 * 发送前的展开：输入框里是一条完整的斜杠命令时，把它换成真正发给模型的内容。
 *
 * 模板 → 替换占位符后的正文；技能 → `/name 说明` 原样保留（正文在磁盘上，
 * 由模型自己按需读，展开成别的东西反而与它看到的一致）。
 * 认不出来就原样返回，绝不在这里吞掉用户输入。
 */
export function expandSlashInput(value: string, commands: readonly SlashCommand[]): string {
  const invocation = parseSlashInvocation(value, commands);
  if (invocation === null) return value;
  if (invocation.command.kind !== "template" || invocation.command.template === undefined) {
    return value;
  }
  return substituteSlashArgs(invocation.command.template, invocation.args);
}
