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
  permissionMode: PermissionMode;
  aiApprovalModel: { serviceId: string; modelId: string } | null;
  skillDirs: string[];
  /** 被用户禁用的技能名；技能仍会被扫描到但排除出系统提示词 */
  disabledSkillNames: string[];
}
