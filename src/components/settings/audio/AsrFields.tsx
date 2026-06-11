// ASR 字段组件
import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export interface AsrValue {
  apiKey: string;
  baseURL: string;
  model: string;
  language?: string;
}

function previewUrl(baseURL: string, fallback: string, endpoint: string): string {
  const base = (baseURL || fallback).trim().replace(/\/+$/, "");
  return `${base}${endpoint}`;
}

export function AsrFields({
  value,
  onChange,
}: {
  value: AsrValue;
  onChange: (patch: Partial<AsrValue>) => void;
}) {
  const [showKey, setShowKey] = useState(false);

  return (
    <>
      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          Base URL
        </label>
        <input
          type="text"
          value={value.baseURL}
          onChange={(e) => onChange({ baseURL: e.target.value })}
          placeholder="https://api.openai.com/v1"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
        />
        <p className="mt-1.5 text-xs text-muted-foreground">
          实际请求：{previewUrl(value.baseURL, "https://api.openai.com/v1", "/audio/transcriptions")}
        </p>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          API Key
        </label>
        <div className="relative">
          <input
            type={showKey ? "text" : "password"}
            value={value.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="sk-..."
            className="h-10 w-full rounded-lg border border-input bg-background px-3 pr-10 text-sm outline-none focus:border-ring"
          />
          <button
            type="button"
            onClick={() => setShowKey(!showKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          识别模型
        </label>
        <input
          type="text"
          value={value.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="whisper-1"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
        />
      </div>

      <div>
        <label className="mb-2 block text-xs font-medium text-muted-foreground">
          语言 (可选，如 zh/en，留空自动检测)
        </label>
        <input
          type="text"
          value={value.language ?? ""}
          onChange={(e) => onChange({ language: e.target.value })}
          placeholder="zh"
          className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring"
        />
      </div>
    </>
  );
}
