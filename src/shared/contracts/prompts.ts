import type { SkillSource } from "./skills";

/**
 * 提示模板列表项。
 * 与 SkillInfo 的差别只有两点：没有 filePath（内核的 PromptTemplate 不返回文件路径），
 * 以及正文 content 随列表一起下发 —— 设置面板需要预览模板内容。
 */
export interface PromptTemplateInfo {
  name: string;
  /** 内核里 description 是可选的，这里统一成字符串（缺失时给空串） */
  description: string;
  /** 模板正文，面板需要预览 */
  content: string;
  source: SkillSource;
  /** 来自哪个目录（不是文件路径 —— 内核不返回 filePath） */
  dir: string;
}
