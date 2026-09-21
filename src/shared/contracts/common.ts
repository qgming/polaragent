// 跨进程共享的通用类型：不依赖 Electron/Node 运行时，渲染进程与主进程均可引用。

export type LanguageCode = "zh-CN" | "en-US";

export type ThemeMode = "light" | "dark" | "system";

export type DensityMode = "comfortable" | "compact";

export type PermissionMode = "default" | "ai_review" | "full";

/**
 * 智能体模式：决定**系统提示里怎么写**，不影响能力。
 *
 * - `standard`：通用助手。写作、调研、规划、文件处理、编程都是它的工作，
 *   所以身份句不能写成「编程助手」，并且要显式地「先判断这是什么任务」。
 * - `orchestrate`：编排者。只做计划、分派、综合与验收，把实现交给子智能体。
 *
 * **两个模式的工具与子智能体能力完全相同**（都能派内置/用户定义、都能用临时定义）——
 * 唯一的差别是系统提示里写不写「委派路由规则」那一段。
 *
 * 为什么不做成能力开关：能力层的差异（哪些工具可用）会牵动工具表，而工具表的
 * 整表替换在 `applyMcpTools` 那条路上有已知的坑（漏传一处就会在 MCP 刷新后消失）；
 * 而「用哪个提示」是每个请求现算的，零成本。
 */
export const AGENT_MODES = ["standard", "orchestrate"] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

/** 界面上列出模式的顺序，也是设置面板与 chip 的顺序 */
export const DEFAULT_AGENT_MODE: AgentMode = "standard";

export type WireFormat = "openai-completions" | "openai-responses";

/** 模型引用：服务 id + 该服务下的模型 id */
export interface ModelRef {
  /** 服务 id（ModelServiceConfig.id，同时也是 pi-ai 侧的 provider id） */
  serviceId: string;
  /** 该服务下的模型 id */
  modelId: string;
}

/**
 * 用户可选的思考档位。取 pi-ai `ModelThinkingLevel` 的前五档：内核另有 `xhigh` / `max`，
 * 但那是给特定模型（Anthropic 自适应思考等）用的，不做成通用选项 —— 目录里读到时仍会被
 * 识别与透传，只是不出现在界面上。
 */
export const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;

export type ThinkingLevel = (typeof ALL_THINKING_LEVELS)[number];
