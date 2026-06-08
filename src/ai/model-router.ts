import type { Api, Model } from "@earendil-works/pi-ai";
import { providerManager, type RuntimeProvider } from "./providers";
import type { AgentConfig } from "@/types/config";
import { useConfigStore } from "@/stores/config-store";

export interface RoutedModelService {
  provider: RuntimeProvider;
  model: Model<Api>;
}

function agentConfig(agentId: string): AgentConfig | undefined {
  return useConfigStore.getState().agents.find((item) => item.id === agentId);
}

export function resolveModelService(agentId: string): RoutedModelService | null {
  const agent = agentConfig(agentId);
  const lockedProviderId = agent?.config.provider?.trim() || "";
  const lockedModelId = agent?.config.model?.trim() || "";

  if (lockedProviderId && lockedModelId) {
    const provider = providerManager.getProvider(lockedProviderId);
    const model = provider?.getModel(lockedModelId);
    if (provider && model) {
      return { provider, model };
    }
  }

  return defaultModelService();
}

function defaultModelService(): RoutedModelService | null {
  const provider = providerManager.getDefaultProvider() ?? undefined;
  if (!provider) return null;
  const model = provider.getModel(providerManager.getDefaultModelId());
  return model ? { provider, model } : null;
}

export function resolveRuntimeModelId(agentId: string): string {
  return resolveModelService(agentId)?.model.id ?? "";
}

export function requireModelService(agentId: string): RoutedModelService {
  const service = resolveModelService(agentId);
  if (!service) {
    throw new Error(
      "没有可用 AI 模型服务。请先在设置 > 模型设置中配置服务商、API Key 和模型。",
    );
  }
  return service;
}

export function firstModelService(): RoutedModelService | null {
  const agents = useConfigStore.getState().agents;
  for (const agent of agents) {
    const service = resolveModelService(agent.id);
    if (service) return service;
  }

  return defaultModelService();
}
