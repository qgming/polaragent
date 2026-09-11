// 提示词模板：用 {{name}} 占位符把运行时数据填进内置提示词。
// 缺失的键替换为空串而不是抛错——一段素材缺失不该让整次调用失败。

/** {{name}} 占位符；名字限定为字母、数字与下划线，避免误伤正文里的花括号 */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** 渲染模板：把 values 里的值按占位符填进去（会多次替换同一个占位符） */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => values[name] ?? "");
}
