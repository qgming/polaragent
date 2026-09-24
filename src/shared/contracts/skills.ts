/**
 * 技能来源：内置（随应用提供） / 用户添加（数据目录与项目目录里的 SKILL.md） /
 * 全局（跨工具共享目录 `~/.agents/skills`）。
 *
 * 与 SubagentSource 同一口径：用户不需要关心文件放在数据目录还是项目目录，
 * 「是不是应用自带的」才是 UI 上唯一要区分的事。磁盘扫描项一律是 user。
 *
 * `agents` 是**跨工具共享**那一档：目录约定 `~/.agents/skills`（Claude Code / Codex /
 * Cursor / ZCode 都扫它），技能格式几家一致。它与 `user` 的区别只有一处，但那一处
 * 决定了界面上该给什么动作：**这里出现的技能不是 Oint 装的，也不归 Oint 删** ——
 * 用户能在设置里禁用（禁用名单按名字匹配），但不能删除（删掉会让别的工具一起丢技能）。
 *
 * ⚠️ 提示模板（`PromptTemplateInfo`）共用这个类型，但**不产生** `agents`：
 * `~/.agents/commands` 这一档还没做，将来要做时是同一个形状。
 */
export type SkillSource = "builtin" | "user" | "agents";

/** 技能列表项（内容不随列表下发，避免大 payload） */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  /** 是否被用户禁用；禁用后不注入系统提示词，但仍可在斜杠菜单手动调用 */
  disabled: boolean;
}

/** 技能详情：面板点击某一行时读取，正文随详情一起给（列表里不带） */
export interface SkillDetail {
  name: string;
  description: string;
  filePath: string;
  /** SKILL.md 原文（含 frontmatter），详情弹窗直接展示 */
  content: string;
}

/**
 * zip 导入结果。
 *
 * `skills` 是导入后重新扫描到的技能数 —— zip 里可能只有一堆散文件（没有 SKILL.md），
 * 界面要靠它告诉用户「导入了但一个技能都没识别出来」，而不是静默成功。
 */
export interface SkillImportResult {
  /** 用户在文件选择框里取消 */
  canceled: boolean;
  /** 实际写入磁盘的文件条目数 */
  files: number;
  /** 重新扫描后数据目录里能识别的技能数 */
  skills: number;
  /** 跳过/失败说明（路径越界、超限、目录条目等），直接显示给用户 */
  diagnostics: string[];
}
