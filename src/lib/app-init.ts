// 应用初始化逻辑
// src/lib/app-init.ts

import { useConfigStore } from "@/stores/config-store";
import { useChatStore } from "@/stores/chat-store";
import { useSkillsStore } from "@/stores/skills/skills-store";
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
    // 1. 初始化配置（最先，后续会话/技能都依赖数据目录）
    await useConfigStore.getState().initialize();
    await applyAutomationRuntimeSettings();
    console.log("✓ 配置初始化完成");

    // 2. 会话优先加载，填充侧边栏（用户最先看到的内容）。
    //    这些数据只依赖数据目录，与后面的技能/MCP 无关；先发起，末尾再兜底 await 捕获错误。
    const sidebarPromise = Promise.all([
      useChatStore
        .getState()
        .hydrateThreads()
        .then(() => console.log("✓ 对话会话加载完成")),
      // 项目配置：并行预加载，供侧边栏项目列表和对话提示词注入
      useProjectsStore
        .getState()
        .loadProjects()
        .then(() => console.log("✓ 项目列表加载完成")),
      // 知识库列表：仅依赖数据目录，与会话同级并行预加载，
      // 启动后即就绪，避免进入知识库页或对话引用知识库时才加载。
      useKnowledgeStore
        .getState()
        .loadKnowledgeBases()
        .then(() => console.log("✓ 知识库列表加载完成")),
    ]).catch((error) => console.error("侧边栏加载失败:", error));

    // 3. 技能 / 工具（MCP）—— 排在会话之后。
    // 3.1 初始化 Skills（loadSkills 内部会执行 skillLoader.initialize()，
    //     既填充 skillLoader 单例，也填充 skills-store 供 UI 订阅）
    await useSkillsStore.getState().loadSkills();
    console.log("✓ Skills 初始化完成");

    // 3.2 初始化模型服务
    initializeAiRuntime();

    // 3.3 加载并刷新 MCP。内置 MCP 来自 {dataDir}/mcp/builtin，
    //     已安装 MCP 来自 {dataDir}/mcp/*.json。
    await useToolsStore.getState().loadBuiltinMcpTools();
    await useToolsStore.getState().refreshBuiltinMcpTools();
    await useToolsStore.getState().loadInstalledMcpTools();
    await useToolsStore.getState().refreshInstalledMcpTools();
    console.log("✓ 技能/工具加载完成");

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
