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
}
