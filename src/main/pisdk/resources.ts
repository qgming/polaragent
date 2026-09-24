// 资源目录解析：技能、提示模板、子智能体定义这些「磁盘上的目录」只应有一处解析规则。
//
// 为什么单独放一个文件：ipc 下的各列表通道（设置面板用）与 pisdk runtime（装配 AgentHarness
// 时把技能与提示模板注入 harness）必须看到同一批目录，否则「面板里显示的」和「实际注入的」
// 会悄悄漂移。抽出本文件就是为了共用这一份解析。
//
// 目录只由文件夹约定决定，没有用户可配置的目录列表：技能、提示模板、子智能体定义与 MCP
// 一样各自住在自己的文件夹里（数据目录下的 skills/ prompts/ subagents/，以及会话工作目录
// 下的 .oint/ 同名子目录）。再给一份用户配置的目录列表，等于给「资源到底从哪来」多造一处
// 需要同步的真相 —— 目录选择器因此被移除，扫描范围只有下面几种来源。

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { dataDir } from "@/main/app/paths";
import { pluginContributionDirs } from "@/main/plugins/contributions";

/**
 * 跨工具共享的技能目录：`~/.agents/skills`。
 *
 * `~/.agents/` 是**跨工具**的约定目录（Claude Code / Codex / Cursor / ZCode 都扫它），
 * 而技能格式（`<名字>/SKILL.md` + name/description frontmatter）几家一致 —— 读它等于让
 * 用户手上已有的那一份技能在 Oint 里也能用，不必先导入一遍。
 *
 * **只读它，不写它**：Oint 的导入与删除只作用于 `<dataDir>/skills`（用户自己那一份），
 * 这里出现的技能在设置面板里可以禁用（禁用名单按名字匹配，与来源无关），但不能删 ——
 * 删掉它会让**别的工具**一起丢技能，那不是这个面板该做的事。
 *
 * **刻意不参与 `OINT_HOME` 覆盖**：它属于家目录，跟的是用户机器上的既有约定，
 * 不是"这份 Oint 的数据搬到了哪里"。同理**不含** `<工作目录>/.agents/skills` ——
 * 那一档是项目级的，与这里"全局"的定位不是一件事。
 *
 * `home` 可注入只为一个理由：单测要钉住这个路径形状，而 `homedir()` 是机器相关的。
 */
export function agentsSkillsDir(home: string = homedir()): string {
  return path.join(home, ".agents", "skills");
}

/**
 * 解析技能目录清单，**顺序即优先级**（同名先出现者胜）：
 * 1. `${dataDir()}/skills` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/skills` —— 会话工作目录下的项目级技能，workingDir 缺失时跳过；
 * 3. `~/.agents/skills` —— **跨工具共享目录**，始终参与扫描（见 `agentsSkillsDir`）；
 * 4. `${appPath}/resources/skills` —— **随包分发的内置技能**，appPath 缺失时跳过。
 *
 * 本函数是 ipc/skills.ts（设置面板的技能列表）与 pisdk runtime（把技能目录注入
 * harness / 系统提示词）共用的唯一解析入口——抽它出来就是为了让「面板看到的」与
 * 「运行时注入的」同源，两处不要再各写一份。
 *
 * **内置技能排在最后**：这样用户永远能用同名技能覆盖内置的（与子智能体目录
 * 「同名用户定义优先」同一条原则）。而它**不拷贝到数据目录**，所以升级应用时
 * 整包替换就完成了更新，不存在「用户改过的旧副本」需要迁移 —— 这也是为什么
 * 这里不需要 omo 那套 manifest / 暂存机制。
 *
 * 边界处理：workingDir 为 undefined 或空串时不追加项目目录。
 *
 * ## 插件贡献的目录（第四个来源）
 *
 * `pluginSkills` 缺省取**当前插件快照**（见 main/plugins/contributions.ts）。
 * 插件的技能排在**跨工具共享目录之后、内置之前**：
 *
 * ```
 * dataDir/skills → workingDir/.oint/skills → ~/.agents/skills → 插件的 skills/ → 内置 resources/skills
 * ```
 *
 * 这个位置是刻意的：**用户永远能覆盖插件**（用户自己写的东西优先于别人给的），
 * 而插件能覆盖随包分发的内置资源（插件是按用户意愿装的，比出厂内容更贴近他的意图）。
 * 顺序即优先级（同名先出现者胜），内核的 loadSkills 按这个数组逐个扫。
 *
 * 单测要纯行为时显式传 `[]` —— 那时它完全不看快照。
 *
 * `sharedSkills` 同理可注入（缺省 `~/.agents/skills`）：这条**必须**与
 * `runtime.ts` 的 `sessionAllowedRoots` 同步，否则技能目录存在却一个都读不到
 * （那两处的耦合已踩过两次，见那里与 `contributions.test.ts` 的断言）。
 */
export function resolveSkillDirs(
  workingDir?: string,
  appPath?: string,
  pluginSkills: readonly string[] = pluginContributionDirs().skills,
  sharedSkills: readonly string[] = [agentsSkillsDir()],
): string[] {
  const dirs = [`${dataDir()}/skills`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/skills`);
  }
  dirs.push(...sharedSkills);
  dirs.push(...pluginSkills);
  if (appPath !== undefined && appPath !== "") {
    dirs.push(resolveBuiltinSkillDir(appPath));
  }
  return dirs;
}

/**
 * 内置技能目录：`${appPath}/resources/skills`。
 *
 * **不 import electron**：`app.getAppPath()` 由调用方注入（与 kernel-deps.ts 同一手法），
 * 单测可以直接喂临时目录。产出路径在开发期是仓库根，打包后是 asar 根 —— 两种情况下
 * `resources/` 都在它下面（见 electron-builder.yml 的 `files:`）。
 *
 * ⚠️ **打包配置必须包含 `resources/**` 才会生效**：`electron-builder.yml` 的 `files:`
 * 漏了这一行时，症状是「开发模式一切正常、打包后内置技能为 0」——
 * 因为 asar 里根本没有这个目录（不是代码出错，是文件没进包）。
 *
 * ## 打包后为什么返回 `app.asar.unpacked` 那一份
 *
 * asar 是一个**归档文件**，只有 Electron 自己的 fs 补丁认得它。模型用 bash 起的
 * `node` / `python` 是独立进程 —— 对它们来说 `app.asar` 就是个文件，
 * 打开里面的路径一律 ENOENT（实测确认）。
 *
 * 而内置技能自带的 `scripts/` **正是要被外部解释器执行的**，所以留在 asar 里等于
 * 永远跑不了。因此 `electron-builder.yml` 把 `resources/**` 整个 `asarUnpack` 出来，
 * 这里优先返回那个真实路径：
 *
 * - 索引里的 `<location>` 因此是**外部进程可用的路径**，`read` 与 `bash` 两条路一致；
 * - 开发期没有 `.unpacked` 目录，于是回落到普通路径 —— 逻辑只有一条分支。
 */
export function resolveBuiltinSkillDir(appPath: string): string {
  const packed = path.join(appPath, "resources", "skills");
  // 打包后 appPath 形如 `.../app.asar`；解包目录是它的兄弟 `app.asar.unpacked`
  const unpacked = path.join(`${appPath}.unpacked`, "resources", "skills");
  return existsSync(unpacked) ? unpacked : packed;
}

/**
 * 解析提示模板目录清单，**顺序即优先级**（同名先出现者胜），与 resolveSkillDirs 同源同构：
 * 1. `${dataDir()}/prompts` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/prompts` —— 会话工作目录下的项目级模板，workingDir 缺失时跳过；
 * 3. `${appPath}/resources/prompts` —— **随包分发的内置魔法提示**，appPath 缺失时跳过。
 *
 * **内置层排在最后**：用户永远能用同名模板覆盖内置的（与技能、子智能体同一条原则）；
 * 它也不拷贝到数据目录，升级时整包替换即完成更新 —— 数据目录里因此不存在「用户改过的旧副本」。
 *
 * appPath 是**可选**参数（与 resolveSkillDirs 同一手法）：不给就只扫数据目录与项目目录，
 * 测试与不关心内置层的调用方可以省略。
 *
 * ⚠️ 调用方还有第二处必须同步：`runtime.ts` 的 `sessionAllowedRoots` 要把内置模板目录也加进
 * 允许根，否则内核的 listDir 会被路径守卫拒绝 —— 症状是「目录存在却 0 个内置模板」，
 * 而且只有 diagnostics 里一行警告（见 ipc/prompts.ts 里 scanPromptDir 的注释）。
 *
 * 注意 pi 的 `loadPromptTemplates` 只读目录的**直接子级** .md（不递归），与 loadSkills 的递归遍历不同。
 */
export function resolvePromptTemplateDirs(
  workingDir?: string,
  appPath?: string,
  pluginPrompts: readonly string[] = pluginContributionDirs().prompts,
): string[] {
  const dirs = [`${dataDir()}/prompts`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/prompts`);
  }
  // 插件贡献的模板同样排在项目之后、内置之前（理由见 resolveSkillDirs）
  dirs.push(...pluginPrompts);
  if (appPath !== undefined && appPath !== "") {
    dirs.push(resolveBuiltinPromptDir(appPath));
  }
  return dirs;
}

/**
 * 内置魔法提示目录：`${appPath}/resources/prompts`。
 *
 * 与 `resolveBuiltinSkillDir` **逐字同构**（原因也相同，见那个函数的注释）：内置技能与内置提示
 * 都住在同一份 `resources/` 下，打包后被整个 `asarUnpack` 出来，所以这里同样优先返回
 * `app.asar.unpacked` 那一份真实路径 —— 两种资源的读法一致，排查时不必再想一遍。
 *
 * 同样**不 import electron**：appPath 由调用方注入（开发期是仓库根，打包后是 asar 根）。
 */
export function resolveBuiltinPromptDir(appPath: string): string {
  const packed = path.join(appPath, "resources", "prompts");
  const unpacked = path.join(`${appPath}.unpacked`, "resources", "prompts");
  return existsSync(unpacked) ? unpacked : packed;
}

/**
 * 解析子智能体定义目录清单，顺序固定为：
 * 1. `${dataDir()}/subagents` —— 数据目录下的全局位置，始终参与扫描；
 * 2. `${workingDir}/.oint/subagents` —— 会话工作目录下的项目级定义，workingDir 缺失时跳过；
 * 3. **插件贡献的目录**（排在最后，理由见 resolveSkillDirs：用户覆盖插件）。
 *
 * ipc/subagents.ts（设置面板的定义列表）与 pisdk/subagent-catalog.ts（装配子会话时读取定义）
 * 共用这一份解析，两处不要再各写一份。
 */
export function resolveSubagentDirs(
  workingDir?: string,
  pluginSubagents: readonly string[] = pluginContributionDirs().subagents,
): string[] {
  const dirs = [`${dataDir()}/subagents`];
  if (workingDir !== undefined && workingDir !== "") {
    dirs.push(`${workingDir}/.oint/subagents`);
  }
  dirs.push(...pluginSubagents);
  return dirs;
}
