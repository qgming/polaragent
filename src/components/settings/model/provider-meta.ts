// 供应商接口格式的共享元数据与工具
import type { ProviderConfig } from "@/types/config";

// 三种接口格式的展示名
export const PROVIDER_TYPE_LABELS: Record<ProviderConfig["type"], string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
};

export const PROVIDER_TYPE_OPTIONS = (
  Object.keys(PROVIDER_TYPE_LABELS) as Array<ProviderConfig["type"]>
).map((value) => ({ value, label: PROVIDER_TYPE_LABELS[value] }));

// 生成一个简单的 provider id（开发阶段：随机后缀足够）
export function makeProviderId() {
  return `provider-${Math.random().toString(36).slice(2, 8)}`;
}
