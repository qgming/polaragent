// 配置管理 Store
// src/stores/config-store.ts

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Settings,
  ProvidersConfig,
  ProviderConfig,
  AgentConfig,
} from "@/types/config";
import {
  getDataDir,
  ensureDataDir,
  deleteAgentConfig,
  listAgents,
  readAgentConfig,
  readConfig,
  writeAgentConfig,
  writeConfig,
} from "@/lib/electron/electron-api";
import {
  defaultSettings,
  defaultProviders,
} from "@/config/defaults";
import {
  ALL_SKILLS_ID,
  normalizeSkillSelection,
} from "@/lib/skill";
import { pMap, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";

interface ConfigState {
  // 状态
  dataDir: string;
  settings: Settings;
  providers: ProvidersConfig;
  agents: AgentConfig[];
  isLoading: boolean;
  error: string | null;

  // 初始化
  initialize: () => Promise<void>;

  // Settings 操作
  loadSettings: () => Promise<void>;
  saveSettings: (settings: Settings) => Promise<void>;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;

  // 模型服务操作
  loadProviders: () => Promise<void>;
  saveProviders: (providers: ProvidersConfig) => Promise<void>;
  addProvider: (provider: ProviderConfig) => Promise<void>;
  updateProvider: (
    id: string,
    updates: Partial<ProviderConfig>,
  ) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  setDefaultProvider: (id: string) => Promise<void>;
  setDefaultModel: (providerId: string, modelId: string) => Promise<void>;

  // Agents 操作
  loadAgents: () => Promise<void>;
  addAgent: (agent: AgentConfig) => Promise<void>;
  updateAgent: (id: string, updates: Partial<AgentConfig>) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;

  // 错误处理
  clearError: () => void;
}

export const useConfigStore = create<ConfigState>()(
  persist(
    (set, get) => ({
      // 初始状态
      dataDir: "",
      settings: defaultSettings,
      providers: defaultProviders,
      agents: [],
      isLoading: false,
      error: null,

      // 初始化应用
      initialize: async () => {
        set({ isLoading: true, error: null });

        try {
          // 获取数据目录
          const dataDir = await getDataDir();
          set({ dataDir });

          // 确保目录结构存在
          await ensureDataDir();

          // 加载配置
          await get().loadSettings();
          await get().loadProviders();
          await get().loadAgents();

          console.log("配置初始化完成");
        } catch (error) {
          const message = error instanceof Error ? error.message : "初始化失败";
          set({ error: message });
          console.error("配置初始化失败:", error);

          // 使用默认配置
          set({
            settings: { ...defaultSettings, dataDirectory: get().dataDir },
            providers: defaultProviders,
            agents: [],
          });
        } finally {
          set({ isLoading: false });
        }
      },

      // 加载设置
      loadSettings: async () => {
        try {
          const settings = normalizeSettings(
            await readConfig<Settings>("settings.json"),
            get().dataDir,
          );
          set({ settings });
        } catch (error) {
          console.warn("无法加载设置，使用默认值");
          // 保存默认设置
          const settings = { ...defaultSettings, dataDirectory: get().dataDir };
          await writeConfig("settings.json", settings);
          set({ settings });
        }
      },

      // 保存设置
      saveSettings: async (settings) => {
        try {
          await writeConfig("settings.json", settings);
          set({ settings });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "保存设置失败";
          set({ error: message });
          throw error;
        }
      },

      // 更新设置
      updateSettings: async (updates) => {
        const settings = { ...get().settings, ...updates };
        await get().saveSettings(settings);
      },

      // 加载模型服务
      loadProviders: async () => {
        try {
          const providers = await readConfig<ProvidersConfig>("providers.json");
          set({ providers: normalizeProviders(providers) });
        } catch (error) {
          console.warn("无法加载模型服务，使用默认值");
          // 保存默认配置
          await writeConfig("providers.json", defaultProviders);
          set({ providers: defaultProviders });
        }
      },

      // 保存模型服务
      saveProviders: async (providers) => {
        try {
          await writeConfig("providers.json", providers);
          set({ providers });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "保存模型服务失败";
          set({ error: message });
          throw error;
        }
      },

      // 添加模型服务
      addProvider: async (provider) => {
        const providers = {
          ...get().providers,
          providers: [...get().providers.providers, provider],
        };
        await get().saveProviders(providers);
      },

      // 更新模型服务
      updateProvider: async (id, updates) => {
        const providers = {
          ...get().providers,
          providers: get().providers.providers.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
          ),
        };
        await get().saveProviders(providers);
      },

      // 删除模型服务
      removeProvider: async (id) => {
        const remaining = get().providers.providers.filter((p) => p.id !== id);
        const defaultRemoved = get().providers.defaultProvider === id;
        const nextDefault = defaultRemoved
          ? remaining.find((p) => p.enabled && p.models.length > 0) ?? remaining[0]
          : undefined;
        const providers = {
          ...get().providers,
          providers: remaining,
          defaultProvider: nextDefault?.id ?? (defaultRemoved ? "" : get().providers.defaultProvider),
          defaultModel: nextDefault
            ? nextDefault.config.defaultModel?.trim() || nextDefault.models[0]?.id || ""
            : defaultRemoved
              ? ""
              : get().providers.defaultModel,
        };
        await get().saveProviders(providers);
      },

      // 设置默认模型服务
      setDefaultProvider: async (id) => {
        const providers = {
          ...get().providers,
          defaultProvider: id,
        };
        await get().saveProviders(providers);
      },

      // 设置默认路由模型（模型服务 + 模型 二元组）
      setDefaultModel: async (providerId, modelId) => {
        const providers = {
          ...get().providers,
          defaultProvider: providerId,
          defaultModel: modelId,
        };
        await get().saveProviders(providers);
      },

      // 加载 Agents —— 完全以本地文件为准（builtin/agents 由 Rust 启动时同步到数据目录）
      loadAgents: async () => {
        try {
          const agentIds = await listAgents();
          const loadedAgents = await pMap(
            agentIds,
            (agentId) => readAgentConfig<AgentConfig>(agentId),
            { concurrency: LOCAL_IO_CONCURRENCY },
          );
          // 仅做结构归一化（补缺失的可选字段），不写回磁盘、不注入代码内容
          set({ agents: loadedAgents.map(normalizeAgent) });
        } catch (error) {
          console.warn("无法加载 Agents", error);
          set({ agents: [] });
        }
      },

      // 添加 Agent
      addAgent: async (agent) => {
        const agents = [...get().agents, agent];
        await writeAgentConfig(agent.id, agent);
        set({ agents });
      },

      // 更新 Agent
      updateAgent: async (id, updates) => {
        const agents = get().agents.map((a) =>
          a.id === id ? { ...a, ...updates } : a,
        );
        const agent = agents.find((a) => a.id === id);
        if (agent) {
          await writeAgentConfig(id, agent);
        }
        set({ agents });
      },

      // 删除 Agent
      removeAgent: async (id) => {
        const agents = get().agents.filter((a) => a.id !== id);
        await deleteAgentConfig(id);
        set({ agents });
      },

      // 清除错误
      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: "polaragent-config",
      // 只持久化部分状态
      partialize: (state) => ({
        dataDir: state.dataDir,
      }),
    },
  ),
);

// 结构归一化：仅补齐缺失的可选字段，不覆盖磁盘上的任何内容
function normalizeAgent(agent: AgentConfig): AgentConfig {
  const type = agent.type ?? (agent.id === "default" ? "builtin" : "custom");
  const enabledSkills = normalizeSkillSelection(agent.config.enabledSkills);
  const shouldUseAllSkills =
    agent.id === "default" && type === "builtin" && enabledSkills.length === 0;

  return {
    ...agent,
    type,
    config: {
      ...agent.config,
      model: agent.config.model ?? "",
      enabledSkills: shouldUseAllSkills ? [ALL_SKILLS_ID] : enabledSkills,
    },
  };
}

// 归一化 providers 配置：补齐旧版 providers.json 可能缺失的 defaultProvider/defaultModel
// 字段，避免 checkProviderConfig 等处对 defaultModel.trim() 在 undefined 上崩溃。
function normalizeProviders(providers: ProvidersConfig): ProvidersConfig {
  return {
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
    defaultProvider: providers?.defaultProvider ?? "",
    defaultModel: providers?.defaultModel ?? "",
  };
}

// 归一化图片生成配置：开发阶段只支持当前结构，缺失字段补默认值。
function normalizeImageGeneration(
  current: Settings["imageGeneration"],
  fallback: NonNullable<Settings["imageGeneration"]>,
): NonNullable<Settings["imageGeneration"]> {
  const raw = (current ?? {}) as Record<string, any>;
  const rawProvider = raw.provider as string | undefined;
  const provider =
    rawProvider === "openai-chat" || rawProvider === "gemini"
      ? rawProvider
      : "openai-images";

  const rawImages = (raw.openaiImages ?? {}) as Record<string, any>;
  const rawChat = (raw.openaiChat ?? {}) as Record<string, any>;
  const rawGemini = (raw.gemini ?? {}) as Record<string, any>;

  return {
    provider,
    openaiImages: {
      apiKey: rawImages.apiKey ?? fallback.openaiImages!.apiKey,
      baseURL: rawImages.baseURL ?? fallback.openaiImages!.baseURL,
      model: rawImages.model ?? fallback.openaiImages!.model,
    },
    openaiChat: {
      apiKey: rawChat.apiKey ?? fallback.openaiChat!.apiKey,
      baseURL: rawChat.baseURL ?? fallback.openaiChat!.baseURL,
      model: rawChat.model ?? fallback.openaiChat!.model,
    },
    gemini: {
      apiKey: rawGemini.apiKey ?? fallback.gemini!.apiKey,
      baseURL: rawGemini.baseURL ?? fallback.gemini!.baseURL,
      model: rawGemini.model ?? fallback.gemini!.model,
    },
  };
}

function normalizeSettings(settings: Settings, dataDir: string): Settings {
  const defaultWebSearch = defaultSettings.webSearch!;
  const defaultImageGeneration = defaultSettings.imageGeneration!;
  const defaultAudio = defaultSettings.audio!;
  const defaultKnowledge = defaultSettings.knowledge!;
  const defaultAutomation = defaultSettings.automation!;
  return {
    ...defaultSettings,
    ...settings,
    appearance: {
      ...defaultSettings.appearance,
      ...settings.appearance,
    },
    behavior: {
      ...defaultSettings.behavior,
      ...settings.behavior,
    },
    window: {
      ...defaultSettings.window,
      ...settings.window,
    },
    dataDirectory: settings.dataDirectory ?? dataDir,
    webSearch: {
      ...defaultWebSearch,
      ...settings.webSearch,
      usage: {
        ...defaultWebSearch.usage,
        ...settings.webSearch?.usage,
      },
      tavily: {
        ...defaultWebSearch.tavily!,
        ...settings.webSearch?.tavily,
        apiKey: settings.webSearch?.tavily?.apiKey ?? defaultWebSearch.tavily!.apiKey,
      },
      exa: {
        ...defaultWebSearch.exa!,
        ...settings.webSearch?.exa,
        apiKey: settings.webSearch?.exa?.apiKey ?? defaultWebSearch.exa!.apiKey,
      },
      serper: {
        ...defaultWebSearch.serper!,
        ...settings.webSearch?.serper,
        apiKey: settings.webSearch?.serper?.apiKey ?? defaultWebSearch.serper!.apiKey,
      },
      searxng: {
        ...defaultWebSearch.searxng!,
        ...settings.webSearch?.searxng,
        instances: settings.webSearch?.searxng?.instances ?? defaultWebSearch.searxng!.instances,
      },
      brave: {
        ...defaultWebSearch.brave!,
        ...settings.webSearch?.brave,
        apiKey: settings.webSearch?.brave?.apiKey ?? defaultWebSearch.brave!.apiKey,
      },
    },
    imageGeneration: normalizeImageGeneration(settings.imageGeneration, defaultImageGeneration),
    audio: settings.audio ?? defaultAudio,
    knowledge: {
      ...defaultKnowledge,
      ...settings.knowledge,
      embedding: {
        ...defaultKnowledge.embedding,
        ...settings.knowledge?.embedding,
      },
      retrieval: {
        ...defaultKnowledge.retrieval,
        ...settings.knowledge?.retrieval,
      },
    },
    automation: {
      ...defaultAutomation,
      ...settings.automation,
      browserUse: {
        ...defaultAutomation.browserUse,
        ...settings.automation?.browserUse,
      },
      computerUse: {
        ...defaultAutomation.computerUse,
        ...settings.automation?.computerUse,
      },
    },
  };
}
