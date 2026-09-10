// 跨进程共享的通用类型：不依赖 Electron/Node 运行时，渲染进程与主进程均可引用。

export type LanguageCode = "zh-CN" | "en-US";

export type ThemeMode = "light" | "dark" | "system";

export type DensityMode = "comfortable" | "compact";

export type PermissionMode = "default" | "ai_review" | "full";

export type WireFormat = "openai-completions" | "openai-responses";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

// 用判别联合表达成功/失败，避免 IPC 边界抛异常后丢失错误上下文。
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
