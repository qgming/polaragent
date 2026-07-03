// 应用初始化逻辑
// src/lib/app-init.ts

import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
import { useSkillsMarketStore } from "@/stores/skills/skills-market-store";
import { useAgentsMarketStore } from "@/stores/agents-market-store";
import { useTeamsStore } from "@/stores/team/teams-store";
import { useTeamChatStore } from "@/stores/team/team-chat-store";
import { useProjectsStore } from "@/stores/project/projects-store";
import { useScheduleStore } from "@/stores/schedule-store";
import { useToolsStore } from "@/stores/tools-store";
import { useKnowledgeStore } from "@/stores/knowledge-store";
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
    await applyAutomationRuntimeSettings();
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
      // 项目配置：与团队同级并行预加载，供侧边栏项目列表和对话提示词注入
      useProjectsStore
        .getState()
        .loadProjects()
        .then(() => console.log("✓ 项目列表加载完成")),
      // 知识库列表：仅依赖数据目录，与会话/团队同级并行预加载，
      // 启动后即就绪，避免进入知识库页或对话引用知识库时才加载。
      useKnowledgeStore
        .getState()
        .loadKnowledgeBases()
        .then(() => console.log("✓ 知识库列表加载完成")),
    ]).catch((error) => console.error("侧边栏加载失败:", error));

    // 紧随侧边栏发起广场 hydrate（不阻塞启动），提前到 MCP 之前发起，
    // 使索引和默认分类更早就绪，用户进入广场页时多半已加载完成。
    // 技能广场：读盘缓存 + 超 24 小时后台刷新；助手广场为内置静态数据，仅读索引。
    void useSkillsMarketStore.getState().hydrate();
    void useAgentsMarketStore.getState().hydrate();

    // 3. 技能 / 助手 / 工具（MCP）—— 排在会话之后。
    // 3.1 初始化 Skills（loadSkills 内部会执行 skillLoader.initialize()，
    //     既填充 skillLoader 单例，也填充 skills-store 供 UI 订阅）
    await useSkillsStore.getState().loadSkills();
    console.log("✓ Skills 初始化完成");

    // 3.2 初始化模型服务 / Agents
    initializeAiRuntime();

    // 3.3 加载并刷新 MCP。内置 MCP 来自 {dataDir}/mcp/builtin，
    //     已安装 MCP 来自 {dataDir}/mcp/*.json。
    await useToolsStore.getState().loadBuiltinMcpTools();
    await useToolsStore.getState().refreshBuiltinMcpTools();
    await useToolsStore.getState().loadInstalledMcpTools();
    await useToolsStore.getState().refreshInstalledMcpTools();
    console.log("✓ 技能/助手/工具加载完成");

    // 3.4 初始化定时任务运行时。依赖配置、技能、Agent 运行时与工具目录，
    // 放在它们之后，确保恢复任务时可直接调用 promptAgent。
    await useScheduleStore.getState().initialize();
    console.log("✓ 定时任务运行时初始化完成");

    // 4. 兜底等待侧边栏加载完成（多数情况下此时早已完成）
    await sidebarPromise;

    console.log("🎉 应用初始化完成！");
    return true;
  } catch (error) {
    console.error("❌ 应用初始化失败:", error);
    return false;
  }
}

async function applyAutomationRuntimeSettings() {
  const automation = useConfigStore.getState().settings.automation;
  if (!automation) return;
  if (automation.browserUse && window.polaragent?.browseruse?.configure) {
    try {
      await window.polaragent.browseruse.configure(automation.browserUse);
    } catch (error) {
      console.warn("Browser Use 运行时配置应用失败:", error);
    }
  }
  if (automation.computerUse && window.polaragent?.computeruse?.configure) {
    try {
      await window.polaragent.computeruse.configure({
        persistentWorker: automation.computerUse.persistentWorker,
        actionTimeoutMs: automation.computerUse.actionTimeoutMs,
      });
    } catch (error) {
      console.warn("Computer Use 运行时配置应用失败:", error);
    }
  }
}

export function initializeAiRuntime() {
  const providersConfig = useConfigStore.getState().providers;
  providerManager.initialize(providersConfig);
  console.log("✓ 模型服务初始化完成");

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
