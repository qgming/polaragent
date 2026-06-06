// 应用初始化逻辑
// src/lib/app-init.ts

import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useSkillsMarketStore } from "@/stores/skills/skills-market-store";
import { useAgentsMarketStore } from "@/stores/agents-market-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useToolsStore } from "@/stores/tools-store";
import { providerManager } from "@/ai/providers";
import { agentManager } from "@/ai/agent-manager";

/**
 * 初始化应用
 */
export async function initializeApp() {
  console.log("开始初始化应用...");

  try {
    // 1. 初始化配置
    await useConfigStore.getState().initialize();
    console.log("✓ 配置初始化完成");

    // 2. 初始化 Skills（loadSkills 内部会执行 skillLoader.initialize()，
    //    既填充 skillLoader 单例，也填充 skills-store 供 UI 订阅）
    await useSkillsStore.getState().loadSkills();
    console.log("✓ Skills 初始化完成");

    // 3. 初始化 Providers
    initializeAiRuntime();

    // 3.1 加载并刷新 MCP。内置 MCP 来自 {dataDir}/mcp/builtin，
    //     已安装 MCP 来自 {dataDir}/mcp/*.json。
    await useToolsStore.getState().loadBuiltinMcpTools();
    await useToolsStore.getState().refreshBuiltinMcpTools();
    await useToolsStore.getState().loadInstalledMcpTools();
    await useToolsStore.getState().refreshInstalledMcpTools();

    // 3.2 加载团队配置（团队会话独立存于 teams 目录，不影响普通对话）
    await useTeamsStore.getState().loadTeams();
    console.log("✓ 团队加载完成");

    // 4. 回读已持久化的会话列表，填充侧边栏
    await useChatStore.getState().hydrateThreads();
    console.log("✓ 历史会话加载完成");

    // 5. 技能广场：读盘缓存 + 超 24 小时后台自动刷新（不阻塞启动）
    void useSkillsMarketStore.getState().hydrate();

    // 6. 助手广场：读盘缓存 + 超 24 小时后台自动刷新（不阻塞启动）
    void useAgentsMarketStore.getState().hydrate();

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
  console.log("✓ Providers 初始化完成");

  const agents = useConfigStore.getState().agents;

  agentManager.clear();
  for (const agentConfig of agents) {
    try {
      agentManager.registerAgentConfig(agentConfig);
    } catch (error) {
      console.error(`Agent 初始化失败: ${agentConfig.name}`, error);
    }
  }
  console.log("✓ Agents 初始化完成");
}

/**
 * 检查 Provider 配置是否完整
 */
export function checkProviderConfig(): {
  isConfigured: boolean;
  message: string;
} {
  const providers = useConfigStore.getState().providers;

  const enabledProviders = providers.providers.filter((p) => p.enabled);

  if (enabledProviders.length === 0) {
    return {
      isConfigured: false,
      message: "请先在设置中配置至少一个 AI Provider",
    };
  }

  const configuredProvider = enabledProviders.find(
    (p) =>
      p.config.apiKey.trim().length > 0 &&
      p.config.baseURL.trim().length > 0 &&
      (p.config.defaultModel?.trim() || p.models[0]?.id?.trim()),
  );

  if (!configuredProvider) {
    return {
      isConfigured: false,
      message: "请在设置中完整配置 Base URL、API Key 和模型名称",
    };
  }

  return {
    isConfigured: true,
    message: "配置正常",
  };
}
