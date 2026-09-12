// 资源目录解析：技能这类「磁盘上的目录」只应有一处解析规则。
//
// 为什么单独放一个文件：ipc/skills.ts（设置面板的技能列表）与 pisdk runtime
// （装配 AgentHarness 时把技能与提示模板注入 harness）必须看到同一批目录，
// 否则「面板里显示的」和「实际注入的」会悄悄漂移。抽出本函数就是为了共用这一份解析。

import { dataDir } from "@/main/app/paths";
import type { Settings } from "@/shared/contracts/settings";
import type { SkillSource } from "@/shared/contracts/skills";

/** 待扫描的技能目录及其来源标记 */
export interface SkillDir {
  path: string;
  source: SkillSource;
}

/**
 * 解析技能目录清单，顺序固定为：
 * 1. settings.skillDirs 中用户配置的目录（global）；
 * 2. `${dataDir()}/skills` —— 数据目录下的全局默认位置，始终参与扫描（global）；
 * 3. `${workingDir}/.pi/skills` —— 会话工作目录下的项目级技能（project），workingDir 缺失时跳过。
 *
 * 本函数是 ipc/skills.ts（设置面板的技能列表）与将来的 pisdk runtime（把技能目录注入
 * harness / 系统提示词）共用的唯一解析入口——抽它出来就是为了让「面板看到的」与
 * 「运行时注入的」同源，两处不要再各写一份。
 *
 * 边界处理（与既有 ipc/skills.ts 行为逐条对齐，勿顺手改）：
 * - 去空值：settings.skillDirs 里的非字符串项与纯空白项跳过；workingDir 为 undefined
 *   或空串时不追加项目目录。
 * - 不去重：同一目录被配置两次会被扫描两次（下游逐目录独立扫描，合并时按技能 name 去重，
 *   最终结果不受影响），因此这里不做去重以免改变顺序语义。
 * - 不做相对路径归一化：settings.skillDirs 里的相对路径原样透出，由调用方（createExecEnv
 *   的 cwd / loadSkills）按上下文解析；数据目录与项目目录沿用 `${...}/skills`、
 *   `${...}/.pi/skills` 的历史拼接写法，不换成 path.join。
 */
export function resolveSkillDirs(
  settings: Pick<Settings, "skillDirs">,
  workingDir?: string,
): SkillDir[] {
  const dirs: SkillDir[] = [];
  for (const dir of settings.skillDirs) {
    if (typeof dir === "string" && dir.trim() !== "") dirs.push({ path: dir, source: "global" });
  }
  // 数据目录下的 skills 作为全局默认位置，始终参与扫描
  dirs.push({ path: `${dataDir()}/skills`, source: "global" });
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push({ path: `${workingDir}/.pi/skills`, source: "project" });
  }
  return dirs;
}

/**
 * 解析提示模板目录清单，顺序固定为：
 * 1. settings.promptTemplateDirs 中用户配置的目录；
 * 2. `${dataDir()}/prompts` —— 数据目录下的全局默认位置，始终参与扫描；
 * 3. `${workingDir}/.pi/prompts` —— 会话工作目录下的项目级模板，workingDir 缺失时跳过。
 *
 * 与 resolveSkillDirs 同源同构。注意 pi 的 `loadPromptTemplates` 只读目录的**直接子级** .md
 * （不递归），与 loadSkills 的递归遍历不同。
 *
 * 边界处理与 resolveSkillDirs 逐条对齐：去空值、不去重、不做相对路径归一化
 * （相对路径由调用方按会话 cwd 解析）。
 */

/** 待扫描的提示模板目录及其来源标记（与 SkillDir 同构） */
export interface PromptTemplateDir {
  path: string;
  source: SkillSource;
}

export function resolvePromptTemplateDirs(
  settings: Pick<Settings, "promptTemplateDirs">,
  workingDir?: string,
): PromptTemplateDir[] {
  const dirs: PromptTemplateDir[] = [];
  for (const dir of settings.promptTemplateDirs) {
    if (typeof dir === "string" && dir.trim() !== "") dirs.push({ path: dir, source: "global" });
  }
  // 数据目录下的 prompts 作为全局默认位置，始终参与扫描
  dirs.push({ path: `${dataDir()}/prompts`, source: "global" });
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push({ path: `${workingDir}/.pi/prompts`, source: "project" });
  }
  return dirs;
}
