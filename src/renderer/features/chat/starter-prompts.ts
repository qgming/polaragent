/**
 * 新会话页下方的「起手提示」：从斜杠命令里挑出**模板**那一类，按固定优先级取前几条。
 *
 * 为什么是模板而不是另写一份写死的清单：模板（`resources/prompts/*.md`）本来就是
 * 「一段现成的提示词」，点它等于把正文填进输入框 —— 与斜杠菜单选中一条模板是**同一个动作**
 * （两处都走 `insertSlashCommand`）。另起一份清单的话，用户改了模板正文，chip 上还是旧的。
 *
 * 为什么还要一份固定顺序：模板是按名字从磁盘扫出来的（顺序不由我们定），而这一排
 * 表达的是「先试试这几个」。挑的是最适合当起手式的几条，不在列表里的模板不进 chip ——
 * 它们仍然在斜杠菜单里，一条不少。
 *
 * 这里只有纯逻辑（不碰 React / IPC），与 slash-commands 同一个口径，可在 node project 下
 * 直接喂普通对象做断言。
 */

import type { SlashCommand } from "./slash-commands";

/** 起手提示的优先顺序；顺序即 chip 从左到右的顺序 */
export const STARTER_PROMPTS: readonly { name: string; labelKey: string }[] = [
  { name: "plan", labelKey: "chat.promptPlan" },
  { name: "debug", labelKey: "chat.promptDebug" },
  { name: "review", labelKey: "chat.promptReview" },
  { name: "verify", labelKey: "chat.promptVerify" },
  { name: "commit", labelKey: "chat.promptCommit" },
  { name: "map", labelKey: "chat.promptMap" },
];

/**
 * 最多显示几条。
 *
 * 四条与 ZCode 的新会话页同数：再多就会换行，而这一排的定位是「一眼扫过的起手式」，
 * 不是「模板的全量入口」（那是斜杠菜单）。
 */
export const STARTER_PROMPT_LIMIT = 4;

/** 一条起手提示：要插入的命令 + 它在这一排上显示的短标签 */
export interface StarterPrompt {
  command: SlashCommand;
  labelKey: string;
}

/**
 * 按优先级挑出这一排要显示的模板。
 *
 * 名字比较大小写不敏感（模板名来自磁盘，实际都是小写，但比较口径与斜杠菜单一致更稳）。
 * 只取 `kind === "template"` 的：技能与内置指令都不是「一段可以填进输入框的提示词」。
 */
export function pickStarterPrompts(commands: readonly SlashCommand[]): StarterPrompt[] {
  const templates = new Map<string, SlashCommand>();
  for (const command of commands) {
    if (command.kind !== "template") continue;
    const name = command.name.toLowerCase();
    // 同名只留第一条：清单本身已按「用户 → 项目 → 内置」去重，这里只是兜底
    if (!templates.has(name)) templates.set(name, command);
  }

  const picked: StarterPrompt[] = [];
  for (const starter of STARTER_PROMPTS) {
    const command = templates.get(starter.name);
    if (command === undefined) continue;
    picked.push({ command, labelKey: starter.labelKey });
    if (picked.length >= STARTER_PROMPT_LIMIT) break;
  }
  return picked;
}
