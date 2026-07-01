// pi-ai Models 适配层
// src/ai/pi-models.ts
//
// 将 polaragent 的 ProviderConfig 体系桥接到 pi-ai 0.80 的 Provider + Models 架构。
// 每个 ProviderConfig 对应一个 pi-ai Provider，由 createProvider() 构建，
// 再用 createModels() 组装为 Models 实例，传给 AgentHarness。

import {
  createModels,
  createProvider,
  type Models,
  type MutableModels,
  type Provider,
  type Model,
  type Api,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import type { ProviderConfig } from "@/types/config";
import { providerSlug } from "./providers";
import { getProviderStreams } from "./providers";

// 缓存 Models 实例，避免重复构造
let cachedModels: Models | null = null;
let cachedConfigSig: string = "";

function configSignature(configs: ProviderConfig[]): string {
  return JSON.stringify(
    configs.map((c) => ({
      id: c.id,
      type: c.type,
      key: c.config.apiKey ? "set" : "",
      url: c.config.baseURL,
      models: c.models.map((m) => m.id),
    })),
  );
}

function buildModelList(config: ProviderConfig): Model<Api>[] {
  const slug = providerSlug(config.type, config.config.baseURL);
  const baseUrl = config.config.baseURL.trim().replace(/\/+$/, "");
  const org = config.config.organization?.trim();

  return config.models.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    api: config.type as Api,
    provider: slug,
    baseUrl,
    reasoning: false,
    input: ["text", "image"] as ("text" | "image")[],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: m.contextWindow || 128000,
    maxTokens: m.maxTokens || 8192,
    headers: org ? { "OpenAI-Organization": org } : undefined,
  }));
}

export function buildModelsFromConfigs(configs: ProviderConfig[]): Models {
  const sig = configSignature(configs.filter((c) => c.enabled));
  if (cachedModels && cachedConfigSig === sig) {
    return cachedModels;
  }

  const models = createModels() as MutableModels;

  for (const config of configs) {
    if (!config.enabled) continue;
    if (!config.config.apiKey.trim() || !config.config.baseURL.trim()) continue;
    if (config.models.length === 0) continue;

    const slug = providerSlug(config.type, config.config.baseURL);
    const modelList = buildModelList(config);
    const apiKey = config.config.apiKey.trim();
    const baseUrl = config.config.baseURL.trim().replace(/\/+$/, "");
    const org = config.config.organization?.trim();

    const provider = createProvider({
      id: slug,
      name: config.name || slug,
      baseUrl,
      headers: org ? { "OpenAI-Organization": org } : undefined,
      auth: {
        apiKey: {
          name: `${config.name || slug} API Key`,
          resolve: async () => ({
            auth: {
              apiKey,
              headers: org ? { "OpenAI-Organization": org } : undefined,
              baseUrl,
            },
            source: "polaragent-config",
          }),
        },
      },
      models: modelList,
      api: getProviderStreams(config.type) as ProviderStreams,
    });

    models.setProvider(provider as Provider<Api>);
  }

  cachedModels = models;
  cachedConfigSig = sig;
  return models;
}

export function resetModelsCache(): void {
  cachedModels = null;
  cachedConfigSig = "";
}
