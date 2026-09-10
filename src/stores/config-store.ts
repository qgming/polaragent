// 配置管理 Store
// src/stores/config-store.ts

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  Settings,
  ProvidersConfig,
  ProviderConfig,
} from "@/types/config";
import {
  getDataDir,
  ensureDataDir,
  readConfig,
  writeConfig,
} from "@/lib/electron/electron-api";
import {
  defaultSettings,
  defaultProviders,
} from "@/config/defaults";

interface ConfigState {
  // 状态
  dataDir: string;
  settings: Settings;
  providers: ProvidersConfig;
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
      isLoading: false,
      error: null,

      // 初始化应用
      initialize: async () => {
        set({ isLoading: true, error: null });

        try {
          const dataDir = await getDataDir();
          set({ dataDir });
          await ensureDataDir();
          await get().loadSettings();
          await get().loadProviders();
          console.log("配置初始化完成");
        } catch (error) {
          const message = error instanceof Error ? error.message : "初始化失败";
          set({ error: message });
          console.error("配置初始化失败:", error);
          set({
            settings: { ...defaultSettings, dataDirectory: get().dataDir },
            providers: defaultProviders,
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

      // 加载 Providers
      loadProviders: async () => {
        try {
          const providers = normalizeProviders(
            await readConfig<ProvidersConfig>("providers.json"),
          );
          set({ providers });
        } catch (error) {
          console.warn("无法加载 Providers，使用默认值");
          set({ providers: defaultProviders });
        }
      },

      // 保存 Providers
      saveProviders: async (providers) => {
        try {
          await writeConfig("providers.json", providers);
          set({ providers });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "保存 Providers 失败";
          set({ error: message });
          throw error;
        }
      },

      // 添加 Provider
      addProvider: async (provider) => {
        const providers = {
          ...get().providers,
          providers: [...get().providers.providers, provider],
        };
        await get().saveProviders(providers);
      },

      // 更新 Provider
      updateProvider: async (id, updates) => {
        const providers = {
          ...get().providers,
          providers: get().providers.providers.map((p) =>
            p.id === id ? { ...p, ...updates } : p,
          ),
        };
        await get().saveProviders(providers);
      },

      // 删除 Provider
      removeProvider: async (id) => {
        const providers = {
          ...get().providers,
          providers: get().providers.providers.filter((p) => p.id !== id),
        };
        await get().saveProviders(providers);
      },

      // 设置默认 Provider
      setDefaultProvider: async (id) => {
        const providers = {
          ...get().providers,
          defaultProvider: id,
        };
        await get().saveProviders(providers);
      },

      // 设置默认模型
      setDefaultModel: async (providerId, modelId) => {
        const providers = {
          ...get().providers,
          defaultProvider: providerId,
          defaultModel: modelId,
        };
        await get().saveProviders(providers);
      },

      // 清除错误
      clearError: () => {
        set({ error: null });
      },
    }),
    {
      name: "polaragent-config",
      partialize: (state) => ({
        dataDir: state.dataDir,
      }),
    },
  ),
);

// 归一化 providers 配置
function normalizeProviders(providers: ProvidersConfig): ProvidersConfig {
  return {
    providers: Array.isArray(providers?.providers) ? providers.providers : [],
    defaultProvider: providers?.defaultProvider ?? "",
    defaultModel: providers?.defaultModel ?? "",
  };
}

function normalizeSettings(settings: Settings, dataDir: string): Settings {
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
  };
}
