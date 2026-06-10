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
  audio: {
    // 语音识别（ASR）：默认 OpenAI Whisper 接口
    asr: {
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      model: "whisper-1",
      language: "",
    },
    // 语音合成（TTS）：默认 MiMo TTS 接口，预置冰糖音色
    tts: {
      apiKey: "",
      baseURL: "https://api.xiaomimimo.com/v1",
      defaultVoice: "bingtang",
      voices: [
        {
          id: "bingtang",
          name: "冰糖",
          provider: "mimo",
          model: "mimo-v2.5-tts",
          voice: "冰糖",
          speed: 1.0,
          format: "mp3",
        },
      ],
    },
    // 语音输入优化选项
    inputOptimization: {
      autoSend: false,
      refineText: false,
    },
  },
  knowledge: {
    embedding: {
      apiKey: "",
      baseURL: "https://api.openai.com/v1",
      model: "text-embedding-3-small",
      dimension: 0, // 0 表示使用模型默认维度，不传 dimensions 参数
    },
    retrieval: {
      topK: 5,
      threshold: 0.6,
      reranker: "none",
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
