// 配置类型定义
// src/types/config.ts

/**
 * 网络搜索服务商类型
 */
export type WebSearchProvider =
  | "tavily"
  | "exa"
  | "serper"
  | "searxng"
  | "brave";

/**
 * 网络搜索配置
 */
export interface WebSearchConfig {
  // 当前选择的服务商
  provider: WebSearchProvider;
  // 各服务商的搜索次数统计
  usage?: {
    tavily?: number;
    exa?: number;
    serper?: number;
    searxng?: number;
    brave?: number;
  };
  // 各服务商的配置
  tavily?: {
    apiKey: string;
    searchDepth?: "basic" | "advanced";
    includeDomains?: string;
    excludeDomains?: string;
    includeAnswer?: boolean; // AI 生成的答案
    includeRawContent?: boolean; // 原始网页内容
    includeImages?: boolean; // 图片链接
  };
  exa?: {
    apiKey: string;
    useAutoprompt?: boolean;
    type?: "neural" | "keyword";
    category?: string;
    includeText?: boolean; // 完整文本内容
    includeHighlights?: boolean; // 高亮摘要
    includeSummary?: boolean; // AI 摘要
  };
  serper?: {
    apiKey: string;
    gl?: string; // 国家代码
    hl?: string; // 语言代码
  };
  searxng?: {
    instances: string; // 多个实例用换行或逗号分隔
  };
  brave?: {
    apiKey: string;
    country?: string;
    searchLang?: string;
  };
}

/**
 * 图片接口标准类型
 *   openai-images  OpenAI 图片接口（/images/generations、/images/edits），兼容多数厂商
 *   openai-chat    OpenAI Chat 多模态接口（/chat/completions 返回图片）
 *   gemini         Google Gemini 接口（:generateContent，responseModalities=["IMAGE"]）
 */
export type ImageApiStandard = "openai-images" | "openai-chat" | "gemini";

/**
 * 图片画幅比例（前端展示与工具调用参数）。
 */
export type ImageAspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "2:3" | "3:2" | "21:9";

/**
 * 图片分辨率档位（前端展示与工具调用参数）。
 */
export type ImageResolution = "1K" | "2K" | "4K";

/**
 * 图片生成配置
 *
 * 接口标准由用户在设置中选择（provider），工具不再自行决定接口格式。
 * 比例（aspectRatio）与分辨率（resolution）不在此处预设，
 * 全部由 AI 在调用工具时按需填写（可选）；设置只负责接入信息。
 */
export interface ImageGenerationConfig {
  // 当前选择的接口标准
  provider: ImageApiStandard;
  // OpenAI 图片接口配置（/images/generations、/images/edits）
  openaiImages?: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  // OpenAI Chat 多模态接口配置（/chat/completions）
  openaiChat?: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
  // Google Gemini 接口配置（:generateContent）
  gemini?: {
    apiKey: string;
    baseURL?: string; // 默认 https://generativelanguage.googleapis.com/v1beta
    model: string; // 如 gemini-3-pro-image-preview
  };
}

/**
 * 音频接口标准类型
 */
export type AudioApiStandard = "audio" | "chat";

/**
 * 音频配置（语音识别 ASR + 语音合成 TTS）
 * 支持 audio 和 chat 两种接口标准
 */
export interface AudioConfig {
  // 语音识别（ASR）
  asr: {
    provider: AudioApiStandard;
    audio?: {
      apiKey: string;
      baseURL: string;
      model: string;
      language?: string;
    };
    chat?: {
      apiKey: string;
      baseURL: string;
      model: string;
      language?: string;
    };
  };
  // 语音合成（TTS）
  tts: {
    provider: AudioApiStandard;
    audio?: {
      apiKey: string;
      baseURL: string;
      model: string;
      defaultVoice: string;
      voices: VoiceConfig[];
    };
    chat?: {
      apiKey: string;
      baseURL: string;
      model: string;
      defaultVoice: string;
      voices: VoiceConfig[];
    };
  };
  inputOptimization?: {
    autoSend?: boolean;
    refineText?: boolean;
  };
}

/**
 * TTS 音色配置
 */
export interface VoiceConfig {
  id: string;
  voice: string;
  speed: number;
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm16";
}

/**
 * 知识库配置
 */
export interface KnowledgeConfig {
  // 嵌入模型配置
  embedding: {
    apiKey: string;
    baseURL: string;
    model: string;
    dimension: number; // OpenAI embeddings dimensions 参数，按模型能力自行填写
  };
  // 检索配置
  retrieval: {
    topK: number; // 每次检索返回的最大结果数 (1-20)
    threshold: number; // 相似度阈值 (0.5-0.95)
    reranker: "none" | "main-model" | "custom"; // 重排序策略
  };
}

/**
 * 长期记忆配置
 */
export interface MemoryConfig {
  // 全局记忆总开关
  enabled: boolean;
  // 自动从完成的对话中提取并写入记忆
  autoWrite: boolean;
  // 自动记忆写入的 token 累计阈值，每积累这么多 token 才触发一次记忆提取
  autoWriteTokenThreshold: number;
  // 是否启用与工作目录绑定的项目记忆
  projectMemoryEnabled: boolean;
  // 检索配置
  retrieval: {
    topK: number;
    threshold: number;
  };
}

/**
 * 内置自动化工具配置
 */
export interface AutomationConfig {
  browserUse: {
    wsPort: number;
    apiPort: number;
    enableHttpApi: boolean;
    actionTimeoutMs: number;
    waitAfterActionMs: number;
    verboseLogs: boolean;
  };
  computerUse: {
    persistentWorker: boolean;
    defaultMaxDepth: number;
    defaultMaxNodes: number;
    includeScreenshotByDefault: boolean;
    screenshotMode: "path" | "base64";
    restoreClipboard: boolean;
    actionTimeoutMs: number;
    // Windows UIA 动作延迟配置（毫秒）
    delays?: {
      ActivateShowWindow: number;
      ActivateForeground: number;
      ClickBefore: number;
      ClickBetween: number;
      ClickAfter: number;
      TypeClipboard: number;
      TypePaste: number;
      DragBefore: number;
      DragBetween: number;
      ScrollBefore: number;
    };
  };
}

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
    // 软件语言：跟随系统 / 简体中文 / English
    language: "system" | "zh-CN" | "en-US";
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
    startInSystemTray: boolean;
    closeToTray: boolean; // 关闭时最小化到托盘保留后台运行
  };
  dataDirectory: string;
  // SkillsMP 技能广场 API Key（可选，匿名亦可搜索但额度低）
  skillsApiKey?: string;
  // 网络搜索配置
  webSearch?: WebSearchConfig;
  // 图片生成配置
  imageGeneration?: ImageGenerationConfig;
  // 音频配置（ASR / TTS）
  audio?: AudioConfig;
  // 知识库配置
  knowledge?: KnowledgeConfig;
  // 长期记忆配置
  memory?: MemoryConfig;
  // 内置自动化工具配置
  automation?: AutomationConfig;
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
  //   anthropic-messages 兼容 Anthropic Messages
  type: "openai-completions" | "openai-responses" | "anthropic-messages";
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

/**
 * Agent 配置
 */
export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  type?: "builtin" | "custom";
  avatar?: string;
  metadata?: {
    author?: string;
    category?: string;
    tags?: string[];
  };
  config: {
    systemPrompt: string;
    provider: string;
    model: string;
    enabledSkills: string[];
  };
}

/**
 * 项目配置（对话分组 + 专属提示词 + 共享工作目录）
 * 项目配置存于 {dataDir}/projects/<id>.json，项目内的对话仍走普通对话仓库。
 */
export interface ProjectConfig {
  id: string;
  name: string;
  // 项目专属提示词：该项目下的所有对话都会注入此提示词
  systemPrompt: string;
  // 项目共享工作目录：项目内所有会话共享同一目录，切换目录时同步更新
  workingDir?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * 会话元数据
 */
export interface ConversationMeta {
  id: string;
  title: string;
  filePath: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  tags?: string[];
}

/**
 * 会话索引
 */
export interface ConversationIndex {
  conversations: ConversationMeta[];
  version: number;
}

/**
 * JSONL 消息格式
 */
export interface JSONLMessage {
  type: "meta" | "message";
  id: string;
  role?: "user" | "assistant";
  content?: string;
  timestamp?: number;
  model?: string;
  usage?: {
    input: number;
    output: number;
    totalTokens: number;
  };
  // 如果是 meta
  title?: string;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Skill 配置（Agent Skills 标准）
 */
export interface SkillConfig {
  id: string;
  name: string;
  description: string;
  version: string;
  type: "builtin" | "custom" | "global";
  enabled: boolean;
  tools: SkillTool[];
  permissions: string[];
  // SKILL.md 的绝对路径：供渐进式披露使用——AI 按此路径主动 read_file 读取技能全文及 references
  filePath?: string;
  settings: {
    license?: string;
    compatibility?: string;
    metadata?: Record<string, string>;
    allowedTools?: string;
    instructions?: string;
    // 0.80 新增：对模型隐藏技能（仅应用显式调用，不出现在模型可见技能清单）
    disableModelInvocation?: boolean;
  };
  supportedLanguages?: string[];
}

/**
 * Skill 工具定义
 */
export interface SkillTool {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required: string[];
  };
}

/**
 * MCP 工具配置
 */
export type {
  McpConfigField,
  McpDiscoveredTool,
  McpInstallCheck,
  McpInstallStatus,
  McpServerConfig,
  McpToolConfig,
  McpTransport,
} from "@/lib/mcp";
