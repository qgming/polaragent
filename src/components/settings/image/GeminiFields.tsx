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
  actualRequestLabel,
  baseUrlLabel,
  imageModelLabel,
  onChange,
}: {
  value: GeminiValue;
  actualRequestLabel: (url: string) => string;
  baseUrlLabel: string;
  imageModelLabel: string;
  onChange: (patch: Partial<GeminiValue>) => void;
}) {
  return (
    <>
      <TextField
        label={baseUrlLabel}
        value={value.baseURL}
        onChange={(v) => onChange({ baseURL: v })}
        placeholder="https://generativelanguage.googleapis.com/v1beta"
        hint={actualRequestLabel(previewGeminiUrl(value.baseURL, "https://generativelanguage.googleapis.com/v1beta", value.model))}
      />
      <ApiKeyField value={value.apiKey} onChange={(v) => onChange({ apiKey: v })} />
      <TextField
        label={imageModelLabel}
        value={value.model}
        onChange={(v) => onChange({ model: v })}
        placeholder="gemini-3-pro-image-preview"
      />
    </>
  );
}
