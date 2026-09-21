import type {
  AgentMode,
  DensityMode,
  LanguageCode,
  ModelRef,
  PermissionMode,
  ThemeMode,
  ThinkingLevel,
  WireFormat,
} from "./common";
import type { McpServerConfig } from "./mcp";

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  /**
   * 是否支持图片输入。
   *
   * 只留这一个布尔、不再存模态列表：pi-ai 的 `Model.input` 也只认 text / image 两种，
   * 而 models.dev 那边的 pdf / audio / video 目前没有任何消费方 —— 存下来只会是一份
   * 会与开关不一致的副本。缺省（undefined）表示「跟随目录结果」。
   */
  acceptsImages?: boolean;
  /**
   * 支持的思考档位（含 "off"）。缺省（undefined）表示「跟随目录结果 / 模型默认」。
   *
   * 权威来源是 pi-ai 目录里每个模型的 `thinkingLevelMap`（`null` = 该档不支持）。
   * 用户可以在设置里改，改完就以此为准。
   */
  thinkingLevels?: ThinkingLevel[];
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
  services: ModelServiceConfig[];
  /** 新会话默认使用的模型；单个会话可在输入框的模型 chip 里覆盖（会话级选择优先） */
  defaultModel: ModelRef | null;
  thinkingLevel: ThinkingLevel;
  /** 审批模式：default 高风险弹卡 / ai_review 交 AI 审批 / full 全部放行；由 Composer 的权限 chip 切换 */
  permissionMode: PermissionMode;
  /**
   * 智能体模式：**新会话**默认用哪个；单个会话可在输入框的模式 chip 里覆盖（会话级优先）。
   *
   * 它只改系统提示（身份、工作方式、委派路由），不改工具表 —— 见 common.ts 的 AgentMode 说明。
   */
  agentMode: AgentMode;
  disabledSkillNames: string[];
  /** 被禁用的子智能体名：内置预设与用户定义共用这一份禁用表（与 disabledSkillNames 同构） */
  disabledSubagentNames: string[];

  /**
   * MCP server 列表（外部工具来源）。连接状态不在这里 —— 它属于运行时的
   * McpServers，只在内存里，见 src/main/pisdk/mcp-servers.ts。
   */
  mcpServers: McpServerConfig[];
}
