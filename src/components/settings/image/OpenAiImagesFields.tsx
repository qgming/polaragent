// 图片模式设置 —— OpenAI 图片接口字段组
// /images/generations · /images/edits：Base URL、API Key、模型。
// 比例 / 分辨率不在设置里预设，统一由 AI 在调用工具时按需填写（可选）。

import {
  TextField,
  ApiKeyField,
  previewOpenAiUrl,
} from "./image-fields-shared";

export interface OpenAiImagesValue {
  apiKey: string;
  baseURL: string;
  model: string;
}

export function OpenAiImagesFields({
  value,
  actualRequestLabel,
  imageModelLabel,
  onChange,
}: {
  value: OpenAiImagesValue;
  actualRequestLabel: (url: string) => string;
  imageModelLabel: string;
  onChange: (patch: Partial<OpenAiImagesValue>) => void;
}) {
  const fallback = "https://api.openai.com/v1";
  return (
    <>
      <TextField
        label="Base URL"
        value={value.baseURL}
        onChange={(v) => onChange({ baseURL: v })}
        placeholder={fallback}
        hint={actualRequestLabel(previewOpenAiUrl(value.baseURL, fallback, "/images/generations"))}
      />
      <ApiKeyField value={value.apiKey} onChange={(v) => onChange({ apiKey: v })} />
      <TextField
        label={imageModelLabel}
        value={value.model}
        onChange={(v) => onChange({ model: v })}
        placeholder="gpt-image-2"
      />
    </>
  );
}
