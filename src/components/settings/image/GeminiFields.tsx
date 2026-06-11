// 图片模式设置 —— Google Gemini 字段组
// :generateContent：Base URL（可选）、API Key、模型。
// 比例 / 分辨率不在设置里预设，统一由 AI 在调用工具时按需填写（可选）。

import {
  TextField,
  ApiKeyField,
  previewGeminiUrl,
} from "./image-fields-shared";

export interface GeminiValue {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function GeminiFields({
  value,
  onChange,
}: {
  value: GeminiValue;
  onChange: (patch: Partial<GeminiValue>) => void;
}) {
  return (
    <>
      <TextField
        label="Base URL（可选，留空使用官方地址）"
        value={value.baseURL}
        onChange={(v) => onChange({ baseURL: v })}
        placeholder="https://generativelanguage.googleapis.com/v1beta"
        hint={`实际请求：${previewGeminiUrl(value.baseURL, "https://generativelanguage.googleapis.com/v1beta", value.model)}`}
      />
      <ApiKeyField value={value.apiKey} onChange={(v) => onChange({ apiKey: v })} />
      <TextField
        label="图片模型"
        value={value.model}
        onChange={(v) => onChange({ model: v })}
        placeholder="gemini-3-pro-image-preview"
      />
    </>
  );
}
