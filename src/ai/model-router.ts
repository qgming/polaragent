// 模型路由 —— 统一使用默认 Provider/Model，不再按助手路由
// src/ai/model-router.ts

import type { Api, Model } from "@earendil-works/pi-ai";
import { providerManager, type RuntimeProvider } from "./providers";

export interface RoutedModelService {
  provider: RuntimeProvider;
  model: Model<Api>;
}

export function resolveModelService(): RoutedModelService | null {
  const provider = providerManager.getDefaultProvider() ?? undefined;
  if (!provider) return null;
  const model = provider.getModel(providerManager.getDefaultModelId());
  return model ? { provider, model } : null;
}

export function resolveDefaultModelService(): RoutedModelService | null {
  return resolveModelService();
}

export function resolveRuntimeModelId(): string {
  return resolveModelService()?.model.id ?? "";
}

export function requireModelService(): RoutedModelService {
  const service = resolveModelService();
  if (!service) {
    throw new Error(
      "没有可用 AI 模型服务。请先在设置 > 模型设置中配置服务商、API Key 和模型。",
    );
  }
  return service;
}

export function firstModelService(): RoutedModelService | null {
  return resolveModelService();
}
