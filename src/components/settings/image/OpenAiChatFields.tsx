// 图片模式设置 —— OpenAI Chat 字段组
// /chat/completions：Base URL、API Key、模型。
// 比例 / 分辨率不在设置里预设，统一由 AI 在调用工具时按需填写（可选）。

import {
  TextField,
  ApiKeyField,
  previewOpenAiUrl,
} from "./image-fields-shared";

export interface OpenAiChatValue {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function OpenAiChatFields({
  value,
  onChange,
}: {
  value: OpenAiChatValue;
  onChange: (patch: Partial<OpenAiChatValue>) => void;
}) {
  const fallback = "https://api.openai.com/v1";
  return (
    <>
      <TextField
        label="Base URL"
        value={value.baseURL}
        onChange={(v) => onChange({ baseURL: v })}
        placeholder={fallback}
        hint={`实际请求：${previewOpenAiUrl(value.baseURL, fallback, "/chat/completions")}`}
      />
      <ApiKeyField value={value.apiKey} onChange={(v) => onChange({ apiKey: v })} />
      <TextField
        label="图片模型"
        value={value.model}
        onChange={(v) => onChange({ model: v })}
        placeholder="如 doubao-seedream / gemini-3-pro-image-preview"
      />
    </>
  );
}
