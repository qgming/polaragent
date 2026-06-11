// 图片模式设置 —— 字段与 Base URL 预览
// 复用共享字段组件，并提供 Base URL 补全预览（仅用于展示，与后端拼接规则保持一致）。

export { ApiKeyField, TextField } from "../shared-fields";

// OpenAI 标准：去掉尾部斜杠；若不以 /v1 结尾则补 /v1，再拼接端点。
// 空输入时退回到 placeholder 默认地址。
export function previewOpenAiUrl(baseURL: string, fallback: string, endpoint: string) {
  const raw = baseURL.trim().replace(/\/+$/, "") || fallback.replace(/\/+$/, "");
  const normalized = raw.endsWith("/v1") ? raw : `${raw}/v1`;
  return `${normalized}${endpoint}`;
}

// Gemini 标准：去掉尾部斜杠；留空使用官方地址，再拼接 /models/{model}:generateContent。
export function previewGeminiUrl(baseURL: string, fallback: string, model: string) {
  const base = (baseURL.trim() || fallback).replace(/\/+$/, "");
  const name = model.trim() || "{model}";
  return `${base}/models/${name}:generateContent`;
}
