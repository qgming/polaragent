import type {
  DensityMode,
  LanguageCode,
  PermissionMode,
  ThemeMode,
  ThinkingLevel,
  WireFormat,
} from "./common";

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ("text" | "image")[];
}

export interface ModelServiceConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  wireFormat: WireFormat;
  models: ModelEntry[];
}

export interface Settings {
  theme: ThemeMode;
  language: LanguageCode;
  density: DensityMode;
  chatFont: string;
  chatFontSize: number;
  defaultWorkingDir: string | null;
  services: ModelServiceConfig[];
  defaultModel: { serviceId: string; modelId: string } | null;
  thinkingLevel: ThinkingLevel;
  /** 审批模式：default 高风险弹卡 / ai_review 交 AI 审批 / full 全部放行；由 Composer 的权限 chip 切换 */
  permissionMode: PermissionMode;
  skillDirs: string[];
  disabledSkillNames: string[];
  /** 是否把技能（SKILL.md）与提示模板注入模型上下文；关闭后退化为纯原生四件套 */
  skillsEnabled: boolean;
  /** 用户自定义的提示模板目录（*.md，只读直接子级）；数据目录的 prompts 与会话目录的 .pi/prompts 始终参与扫描 */
  promptTemplateDirs: string[];
}
