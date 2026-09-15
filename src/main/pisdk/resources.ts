// 资源目录解析：技能、提示模板、子智能体定义这些「磁盘上的目录」只应有一处解析规则。
//
// 为什么单独放一个文件：ipc 下的各列表通道（设置面板用）与 pisdk runtime（装配 AgentHarness
// 时把技能与提示模板注入 harness）必须看到同一批目录，否则「面板里显示的」和「实际注入的」
// 会悄悄漂移。抽出本文件就是为了共用这一份解析。
//
// 目录只由文件夹约定决定，没有用户可配置的目录列表：技能、提示模板、子智能体定义与 MCP
// 一样各自住在自己的文件夹里（数据目录下的 skills/ prompts/ subagents/，以及会话工作目录
// 下的 .oint/ 同名子目录）。再给一份用户配置的目录列表，等于给「资源到底从哪来」多造一处
// 需要同步的真相 —— 目录选择器因此被移除，扫描范围只有下面两种来源。

import { dataDir } from "@/main/app/paths";

/**
 * 解析技能目录清单，顺序固定为：
 * 1. `${dataDir()}/skills` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/skills` —— 会话工作目录下的项目级技能，workingDir 缺失时跳过。
 *
 * 本函数是 ipc/skills.ts（设置面板的技能列表）与 pisdk runtime（把技能目录注入
 * harness / 系统提示词）共用的唯一解析入口——抽它出来就是为了让「面板看到的」与
 * 「运行时注入的」同源，两处不要再各写一份。
 *
 * 边界处理：workingDir 为 undefined 或空串时不追加项目目录；不做相对路径归一化，
 * 数据目录与项目目录沿用 `${...}/skills`、`${...}/.oint/skills` 的拼接写法，不换 path.join。
 */
export function resolveSkillDirs(workingDir?: string): string[] {
  const dirs = [`${dataDir()}/skills`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/skills`);
  }
  return dirs;
}

/**
 * 解析提示模板目录清单，顺序固定为：
 * 1. `${dataDir()}/prompts` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/prompts` —— 会话工作目录下的项目级模板，workingDir 缺失时跳过。
 *
 * 与 resolveSkillDirs 同源同构。注意 pi 的 `loadPromptTemplates` 只读目录的**直接子级** .md
 * （不递归），与 loadSkills 的递归遍历不同。
 */
export function resolvePromptTemplateDirs(workingDir?: string): string[] {
  const dirs = [`${dataDir()}/prompts`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/prompts`);
  }
  return dirs;
}

/**
 * 解析子智能体定义目录清单，顺序固定为：
 * 1. `${dataDir()}/subagents` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/subagents` —— 会话工作目录下的项目级定义，workingDir 缺失时跳过。
 *
 * ipc/subagents.ts（设置面板的定义列表）与 pisdk/subagent-catalog.ts（装配子会话时读取定义）
 * 共用这一份解析，两处不要再各写一份。
 */
export function resolveSubagentDirs(workingDir?: string): string[] {
  const dirs = [`${dataDir()}/subagents`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/subagents`);
  }
  return dirs;
}
