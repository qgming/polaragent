// 配置类型定义
// src/types/config.ts

/**
 * 全局应用设置
 */
export interface Settings {
  version: string;
  appearance: {
    theme: "light" | "dark" | "system";
    density: "compact" | "normal" | "comfortable";
    fontSize: number;
    // 对话内容字体：无衬线 / 衬线 / 等宽
    chatFont: "sans" | "serif" | "mono";
    // 对话内容字号：小 / 中 / 大 / 特大
    chatFontSize: "small" | "medium" | "large" | "xlarge";
  };
  behavior: {
    autoSaveConversations: boolean;
    maxConversationHistory: number;
    startupBehavior: "new-task" | "restore-last-session";
  };
  window: {
    width: number;
    height: number;
    rememberSize: boolean;
  };
  dataDirectory: string;
}

/**
 * AI 模型配置
 */
export interface ModelConfig {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  description?: string;
}

/**
 * Provider 配置
 */
export interface ProviderConfig {
  id: string;
  name: string;
  // 接口格式（与 pi-ai 的 api 字段对齐）：
  //   openai-completions 兼容 OpenAI Chat Completions
  //   openai-responses   兼容 OpenAI Responses
  type: "openai-completions" | "openai-responses";
  enabled: boolean;
  config: {
    apiKey: string;
    baseURL: string;
    organization?: string;
    defaultModel?: string;
  };
  models: ModelConfig[];
}

/**
 * 所有 Providers 的配置
 */
export interface ProvidersConfig {
  providers: ProviderConfig[];
  // 默认对话使用的供应商 id
  defaultProvider: string;
  // 默认对话使用的模型 id（配合 defaultProvider 唯一确定一个模型）
  defaultModel: string;
}
