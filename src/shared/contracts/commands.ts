/**
 * 内置**指令**（斜杠命令里与魔法提示分开的那一类）。
 *
 * 三者的分界只看「谁执行」：
 * - 指令：**应用**执行（压缩上下文、停止本轮…），整条命令**不会变成模型消息**；
 * - 技能：模型执行（正文留在磁盘上，由模型按需读）；
 * - 魔法提示：模型执行（正文就是消息本身）。
 *
 * 为什么指令必须住在代码里、而不是 `prompts/*.md`：它有副作用，要动会话状态。
 * 数据文件驱动的动作等于把「谁能执行什么」交给一堆可被随意改写的 Markdown。
 * 与内置技能同一条原则：随包分发、不可删除、随升级整包替换。
 */

/** 内置指令的稳定 id；加一条指令就在这里加一项，并在下面登记它的规格 */
export type CommandId = "compact";

/** 指令的可用条件（菜单据此置灰，发送路径据此拒绝） */
export type CommandAvailability =
  /** 任何时刻都能执行 */
  | "always"
  /** 只有会话空闲时可用：没有在跑一轮、也没有正在压缩 */
  | "idle";

export interface CommandSpec {
  id: CommandId;
  /** 菜单与输入框里的命令名（不带斜杠）；也就是 `/name` 里的 name */
  name: string;
  /** 菜单里那行摘要的 i18n 键（check-i18n 会校验它存在） */
  descriptionKey: string;
  /** 有参数的命令在菜单里显示的占位提示；无参命令不写 */
  hintKey?: string;
  availability: CommandAvailability;
  /**
   * 命令名之后的文字怎么处理：
   * - `none`：不接受参数，多写了就报用法（避免「我写了说明但它被丢掉」）；
   * - `rest`：原样作为参数交给指令自己解析。
   */
  argMode: "none" | "rest";
}

/**
 * 随包分发的内置指令清单。
 *
 * 顺序即菜单里的顺序（不排序）：把最常用的放在最前。
 */
export const BUILTIN_COMMANDS: readonly CommandSpec[] = [
  {
    id: "compact",
    name: "compact",
    descriptionKey: "chat.commandCompactDesc",
    hintKey: "chat.commandCompactHint",
    availability: "idle",
    argMode: "rest",
  },
];

/** 按名字找内置指令（大小写不敏感，与斜杠菜单的匹配口径一致） */
export function findCommandSpec(name: string): CommandSpec | undefined {
  const needle = name.toLowerCase();
  return BUILTIN_COMMANDS.find((spec) => spec.name.toLowerCase() === needle);
}
