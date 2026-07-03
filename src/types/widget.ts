// Widget 渲染类型定义
// src/types/widget.ts

/**
 * Widget 更新模式
 * - replace: 全量替换，丢弃旧内容重新渲染
 * - patch: 增量更新，保留状态最小化 DOM 更新
 */
export type WidgetUpdateMode = "replace" | "patch";

/**
 * Widget 内容源
 * - inline: 直接内联代码
 * - file: 从 skills 目录加载 .html 模板
 */
export type WidgetContentSource = "inline" | "file";

/**
 * Widget 支持的事件类型
 */
export type WidgetEventType = "click" | "input" | "change" | "submit" | "custom";

/**
 * Widget 内部 -> 主应用 事件消息
 */
export interface WidgetEventMessage {
  type: "WIDGET_EVENT";
  widgetId: string;
  event: WidgetEventType;
  data: unknown;
  timestamp: number;
}

/**
 * 主应用 -> Widget 更新消息
 */
export interface WidgetUpdateMessage {
  type: "WIDGET_UPDATE";
  widgetId: string;
  mode: WidgetUpdateMode;
  html?: string;
  data?: Record<string, unknown>;
}

/**
 * Widget 渲染请求参数（AI 工具使用）
 */
export interface RenderWidgetParams {
  title: string;
  update_mode: WidgetUpdateMode;
  widget_code?: string;
  widget_path?: string;
  data?: Record<string, unknown>;
}

/**
 * Widget 段数据（存储在消息 segments 中）
 */
export interface WidgetSegmentData {
  kind: "widget";
  widgetId: string;
  title: string;
  html: string;
  updateMode: WidgetUpdateMode;
  data?: Record<string, unknown>;
  createdAt: number;
}

/**
 * Widget 安全策略
 */
export interface WidgetSecurityPolicy {
  // 是否允许脚本执行
  allowScripts: boolean;
  // CSP 策略字符串
  csp: string;
  // iframe sandbox 属性
  sandbox: string;
  // 额外禁止的属性/标签
  forbiddenTags: string[];
  forbiddenAttributes: string[];
}

/**
 * 默认 Widget 安全策略
 */
export const DEFAULT_WIDGET_SECURITY: WidgetSecurityPolicy = {
  allowScripts: true,
  csp: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none';",
  sandbox: "allow-scripts",
  forbiddenTags: ["form", "iframe", "object", "embed", "base", "link", "meta", "head"],
  forbiddenAttributes: ["onerror", "onload", "onclick", "onmouseover", "onmouseout", "onfocus", "onblur", "href", "src"],
};

/**
 * Widget 类型枚举
 */
export type WidgetType = "chart" | "form" | "table" | "mockup" | "diagram" | "interactive";
