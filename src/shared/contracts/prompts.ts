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

/** 名称规则：小写字母/数字开头，允许中间短横线，≤40 字符（与文件名一一对应） */
export const PROMPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 把任意输入规范成合法模板名：去 .md、小写、空格与下划线转短横线 */
export function normalizePromptName(raw: string): string {
  return raw
    .replace(/\.md$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** 新建 / 更新一份提示模板的请求体（落盘为 `${数据目录}/prompts/<name>.md`） */
export interface PromptTemplateWriteRequest {
  /** 原名（重命名时用来定位旧文件）；新建时省略 */
  originalName?: string;
  name: string;
  /** frontmatter 里的 description；留空表示不写 frontmatter */
  description: string;
  /** 模板正文（frontmatter 之后的全部内容） */
  content: string;
}
