// 浏览器工具的失败分类。
//
// 为什么要把「失败」从自由文本升级成错误码：工具报错是模型唯一的反馈信号，
// 而自由文本里最要紧的那半句（**为什么**、**下一步该做什么**）常常被写成一句
// 「点击失败」。模型没法据此决策，只能原样重试 —— 于是出现
// 「点了没反应 → 再点一次 → 还是没有」（真实案例：面板收起、视口 0×0 时
// sendInputEvent 静默打空，工具报「已点击（页面没有跳转）」，模型就一直重点）。
//
// code 让工具层能稳定地渲染「重快照 / 重试 / 换目标」这三种建议，
// detail 则是给排查用的结构化现场（viewports、hit 到的元素、期望与实际的签名……）。
//
// 错误码的定义刻意放在 shared/contracts/browser.ts（渲染层与工具层都要按它渲染文案），
// 这里只做「带上 code 的 Error」这一件事 —— 免得主进程与共享契约各写一份枚举。

import type { BrowserErrorCode } from "@/shared/contracts/browser";

export type { BrowserErrorCode };

/**
 * 带错误码的浏览器工具失败。
 *
 * 刻意继承 Error（而不是返回 Result 对象）：服务里每个动作都有七八个失败分支，
 * Result 会把每个调用点都变成一堆 if，而 `try/catch` 在工具层只需写一次。
 * 代价是必须保证「抛出去的都带码」—— 所以 service 的每个 throw 都用这个类，
 * 裸 Error 会被工具层统一归到 TOOL_FAILED（见 toBrowserToolError）。
 */
export class BrowserToolError extends Error {
  readonly code: BrowserErrorCode;
  /** 结构化现场：坐标、视口、命中者、期望/实际的签名…… 供工具层与日志使用 */
  readonly detail?: Record<string, unknown>;

  constructor(code: BrowserErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    // name 显式设置：默认会是 "Error"，日志里分不出是谁抛的
    this.name = "BrowserToolError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

/** 已经是 BrowserToolError 就原样返回，否则包一层（code 缺省 TOOL_FAILED） */
export function toBrowserToolError(
  error: unknown,
  code: BrowserErrorCode = "TOOL_FAILED",
  message?: string,
): BrowserToolError {
  if (error instanceof BrowserToolError) return error;
  const text = error instanceof Error ? error.message : String(error);
  return new BrowserToolError(code, message === undefined ? text : `${message}：${text}`);
}

/** 判断一个值是不是 BrowserToolError（跨 realm 时不依赖 instanceof 有时更好用） */
export function isBrowserToolError(value: unknown): value is BrowserToolError {
  if (value instanceof BrowserToolError) return true;
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown };
  return candidate.name === "BrowserToolError" && typeof candidate.code === "string";
}
