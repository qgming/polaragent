// 应用初始化逻辑
// src/lib/app-init.ts

import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useSkillsMarketStore } from "@/stores/skills/skills-market-store";
import { useAgentsMarketStore } from "@/stores/agents-market-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useTeamChatStore } from "@/stores/team/team-chat-store";
import { useToolsStore } from "@/stores/tools-store";
import { providerManager } from "@/ai/providers";
import { agentManager } from "@/ai/agent-manager";

/**
 * 初始化应用
 */
export async function initializeApp() {
  console.log("开始初始化应用...");

  try {
    // 1. 初始化配置（最先，后续会话/团队/技能都依赖数据目录）
    await useConfigStore.getState().initialize();
    console.log("✓ 配置初始化完成");

    // 2. 会话与团队优先加载，填充侧边栏（用户最先看到的内容）。
    //    两组互不依赖，并行发起：
    //      a) 普通对话会话列表
    //      b) 团队配置 → 团队会话列表（团队会话 hydrate 依赖团队配置归属，故串行）
    //    它们都只依赖数据目录，与后面的技能/MCP 无关；先发起，末尾再兜底 await 捕获错误。
    const sidebarPromise = Promise.all([
      useChatStore
        .getState()
        .hydrateThreads()
        .then(() => console.log("✓ 对话会话加载完成")),
      (async () => {
        await useTeamsStore.getState().loadTeams();
        await useTeamChatStore.getState().hydrateTeamThreads();
        console.log("✓ 团队及团队会话加载完成");
      })(),
    ]).catch((error) => console.error("侧边栏加载失败:", error));

    // 3. 技能 / 助手 / 工具（MCP）—— 排在会话之后。
    // 3.1 初始化 Skills（loadSkills 内部会执行 skillLoader.initialize()，
    //     既填充 skillLoader 单例，也填充 skills-store 供 UI 订阅）
    await useSkillsStore.getState().loadSkills();
    console.log("✓ Skills 初始化完成");

    // 3.2 初始化 Providers / Agents
    initializeAiRuntime();

    // 3.3 加载并刷新 MCP。内置 MCP 来自 {dataDir}/mcp/builtin，
    //     已安装 MCP 来自 {dataDir}/mcp/*.json。
    await useToolsStore.getState().loadBuiltinMcpTools();
    await useToolsStore.getState().refreshBuiltinMcpTools();
    await useToolsStore.getState().loadInstalledMcpTools();
    await useToolsStore.getState().refreshInstalledMcpTools();
    console.log("✓ 技能/助手/工具加载完成");

    // 4. 兜底等待侧边栏加载完成（多数情况下此时早已完成）
    await sidebarPromise;

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
