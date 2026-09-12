// 跨进程共享的通用类型：不依赖 Electron/Node 运行时，渲染进程与主进程均可引用。

export type LanguageCode = "zh-CN" | "en-US";

export type ThemeMode = "light" | "dark" | "system";

export type DensityMode = "comfortable" | "compact";

export type PermissionMode = "default" | "ai_review" | "full";

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

export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

// 用判别联合表达成功/失败，避免 IPC 边界抛异常后丢失错误上下文。
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
