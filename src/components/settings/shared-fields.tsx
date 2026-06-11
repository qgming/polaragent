// 设置面板 —— 共享字段组件
// 各设置模块（图片模式、网络搜索、音频等）复用的输入框样式与基础字段。

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";

// 输入框统一样式
export const inputClass =
  "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus:border-ring";

// 字段标签统一样式
export const labelClass = "mb-2 block text-xs font-medium text-muted-foreground";

// 带显隐切换的 API Key 输入框
export function ApiKeyField({
  value,
  onChange,
  placeholder = "...",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [showKey, setShowKey] = useState(false);
  return (
    <div>
      <label className={labelClass}>API Key</label>
      <div className="relative">
        <input
          type={showKey ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={`${inputClass} pr-10`}
        />
        <button
          type="button"
          onClick={() => setShowKey((v) => !v)}
          aria-label={showKey ? "隐藏密钥" : "显示密钥"}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
        >
          {showKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
    </div>
  );
}

// 文本输入字段（Base URL / 模型等）
export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className={labelClass}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
      />
      {hint ? (
        <p className="mt-1.5 break-all text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
