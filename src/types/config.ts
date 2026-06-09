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
 * 图片生成配置
 */
export interface ImageGenerationConfig {
  // 当前选择的服务商
  provider: "openai" | "openai-compatible";
  // OpenAI / OpenAI 兼容图片生成接口配置
  openai: {
    apiKey: string;
    baseURL: string;
    model: string;
  };
}

/**
 * 音频配置（语音识别 ASR + 语音合成 TTS）
 * TTS 采用音色列表管理，支持添加多个音色配置，AI 可灵活选择。
 */
export interface AudioConfig {
  // 语音识别（ASR）：/audio/transcriptions
  asr: {
    apiKey: string;
    baseURL: string;
    model: string; // 如 whisper-1
    language?: string; // 如 zh / en，留空自动检测
  };
  // 语音合成（TTS）：/audio/speech 或兼容接口
  tts: {
    apiKey: string;
    baseURL: string;
    defaultVoice: string; // 默认音色 ID，对应 voices 列表中的某个 id
    voices: VoiceConfig[]; // 音色列表
  };
  // 语音输入优化选项
  inputOptimization?: {
    autoSend?: boolean; // 转文字后自动发送
    refineText?: boolean; // 转文字后调用模型整理文本（去除口头语）
  };
}

/**
 * TTS 音色配置
 * 每个音色对应一套完整的 TTS 参数（模型、音色标识、语速、格式）。
 */
export interface VoiceConfig {
  id: string; // 唯一标识，如 "bingtang"、"alloy"
  name: string; // 显示名称，如 "冰糖"、"Alloy"
  provider: "openai" | "mimo"; // TTS 服务商，决定调用哪个接口
  model: string; // TTS 模型，如 "mimo-v2.5-tts"、"tts-1"
  voice: string; // 音色标识（手动输入，支持任意值），如 "冰糖"、"alloy"
  speed: number; // 默认语速 0.25 - 4.0
  format: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm16"; // 音频格式
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
 * Team 配置（多 Agent 协作）
 * 团队会话与配置存于 {dataDir}/teams 下，与普通对话物理隔离。
 */
export interface TeamConfig {
  id: string;
  name: string;
  avatar: string; // emoji
  description: string;
  version: string;
  // 协作模式：领导模式或头脑风暴模式
  mode: "leader" | "equal";
  // 领导成员的 agentId（必须是 memberIds 之一，仅领导模式需要）
  leaderId: string;
  // 成员 agentId 列表（含领导）
  memberIds: string[];
  // 团队整体系统提示词
  systemPrompt: string;
  // 团队级技能：对所有成员可用（即使成员自身未启用）
  enabledSkills: string[];
  // 团队工作区目录
  workspaceDir?: string;
  // 单次用户消息内最多自动接力轮数（防死循环，默认 8）
  maxRounds?: number;
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
  type: "builtin" | "custom";
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
