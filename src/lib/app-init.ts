// 应用初始化逻辑
// src/lib/app-init.ts

import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { providerManager } from "@/ai/providers";
import { agentManager } from "@/ai/agent-manager";

/**
 * 初始化应用
 */
export async function initializeApp() {
  console.log("开始初始化应用...");

  try {
    // 1. 初始化配置（最先，后续会话依赖数据目录）
    await useConfigStore.getState().initialize();
    console.log("✓ 配置初始化完成");

    // 2. 会话加载，填充侧边栏（用户最先看到的内容）
    await useChatStore
      .getState()
      .hydrateThreads()
      .then(() => console.log("✓ 对话会话加载完成"));

    // 3. 初始化模型服务
    initializeAiRuntime();

    console.log("🎉 应用初始化完成！");
    return true;
  } catch (error) {
    console.error("❌ 应用初始化失败:", error);
    return false;
  }
}

export function initializeAiRuntime() {
  const providersConfig = useConfigStore.getState().providers;
  providerManager.initialize(providersConfig);
  console.log("✓ 模型服务初始化完成");
  agentManager.clear();
  console.log("✓ Agent 运行时已重置");
}

/**
 * 检查模型设置的默认路由是否可用
 */
export function checkProviderConfig(): {
  isConfigured: boolean;
  message: string;
} {
  const providers = useConfigStore.getState().providers;
  const defaultProvider = providers.providers.find(
    (p) => p.id === providers.defaultProvider,
  );

  if (!defaultProvider) {
    return {
      isConfigured: false,
      message: "请先在设置 > 模型设置中选择默认路由模型",
    };
  }

  const defaultModel = providers.defaultModel.trim() ||
    defaultProvider.config.defaultModel?.trim() ||
    defaultProvider.models[0]?.id?.trim();

  if (
    !defaultProvider.enabled ||
    defaultProvider.config.apiKey.trim().length === 0 ||
    defaultProvider.config.baseURL.trim().length === 0 ||
    !defaultModel
  ) {
    return {
      isConfigured: false,
      message: "请在设置 > 模型设置中完整配置默认模型服务的 Base URL、API Key 和模型名称",
    };
  }

  return {
    isConfigured: true,
    message: "配置正常",
  };
}
