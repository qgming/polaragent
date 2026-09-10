/** 技能来源：全局数据目录 / 会话工作目录 */
export type SkillSource = "global" | "project";

/** 技能列表项（内容不随列表下发，避免大 payload） */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  source: SkillSource;
  /** 是否被用户禁用；禁用后不注入系统提示词，但仍可在斜杠菜单手动调用 */
  disabled: boolean;
}
