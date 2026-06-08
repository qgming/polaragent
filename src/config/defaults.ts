// 默认配置
// src/config/defaults.ts

import type { Settings, ProvidersConfig } from "@/types/config";

/**
 * 默认全局设置
 */
export const defaultSettings: Settings = {
  version: "0.1.0",
  appearance: {
    theme: "light",
    density: "normal",
    fontSize: 14,
    chatFont: "sans",
    chatFontSize: "medium",
  },
  behavior: {
    autoSaveConversations: true,
    maxConversationHistory: 100,
    startupBehavior: "restore-last-session",
  },
  window: {
    width: 1240,
    height: 800,
    rememberSize: true,
    startInSystemTray: false,
  },
  dataDirectory: "", // 运行时设置
  skillsApiKey: "", // SkillsMP 技能广场 API Key（留空走匿名额度）
  webSearch: {
    // 默认服务商：Tavily（免费 1000 次/月，专为 AI 设计）
    provider: "tavily",
    usage: {
      tavily: 0,
      exa: 0,
      serper: 0,
      searxng: 0,
      brave: 0,
    },
    tavily: {
      apiKey: "",
      searchDepth: "basic",
      includeAnswer: false,
      includeRawContent: false,
      includeImages: false,
    },
    exa: {
      apiKey: "",
      type: "neural",
      includeText: false,
      includeHighlights: false,
      includeSummary: false,
    },
    serper: { apiKey: "", gl: "cn", hl: "zh-cn" },
    searxng: { instances: "" },
    brave: { apiKey: "" },
  },
  imageGeneration: {
    provider: "openai",
    openai: {
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      model: "gpt-image-1",
    },
  },
};

/**
 * 默认 Providers 配置
 */
export const defaultProviders: ProvidersConfig = {
  providers: [
    {
      id: "openai-compatible",
      name: "OpenAI Compatible",
      type: "openai-completions",
      enabled: false,
      config: {
        apiKey: "",
        baseURL: "",
        defaultModel: "",
      },
      models: [],
    },
  ],
  defaultProvider: "openai-compatible",
  defaultModel: "",
};

/**
 * 获取用户数据目录的默认路径
 */
export function getDefaultDataDirectory(): string {
  // 这个会在运行时通过 Electron API 获取
  // 这里只是占位符
  return "";
}
