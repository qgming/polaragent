// 助手广场 Store —— 内置中文助手库（agents-zh.json）的读取、缓存与安装
// src/stores/agents-market-store.ts
//
// 数据源为打包在 resources/market/agents/agents-zh.json 的单一 JSON 文件。
// 启动先读盘缓存提升首屏速度，再刷新内置 JSON，方便替换资源文件后立即生效。
// 分类筛选基于各条目的 group 字段在本地去重得出，无需服务端查询。

import { create } from "zustand";
import {
  fetchTextPrompts,
  readConfig,
  writeConfig,
  type MarketAgent,
} from "@/lib/electron/electron-api";
import type { AgentConfig } from "@/types/config";
import { useConfigStore } from "./config-store";

// 本地缓存文件名
const CACHE_FILE = "agents-market-cache.json";

interface MarketCache {
  updatedAt: number;
  agents: MarketAgent[];
}

interface AgentsMarketState {
  agents: MarketAgent[];
  updatedAt: number;
  isLoading: boolean; // 首次无缓存时的前台加载
  isRefreshing: boolean; // 后台刷新中
  error: string | null;
  activeGroup: string; // 当前分类筛选；""=全部
  installingIds: string[];

  // 启动时调用：读盘 + 后台刷新内置 JSON
  hydrate: () => Promise<void>;
  // 读取全量并持久化
  refresh: (force?: boolean) => Promise<void>;
  // 切换分类筛选
  setActiveGroup: (group: string) => void;
  // 以某条提示词创建一个自定义助手（沿用默认 provider/model 配置）
  install: (agent: MarketAgent) => Promise<boolean>;
  clearError: () => void;
}

// 把任意名称转为合法的 agent id 片段
function toSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "agent"
  );
}

export const useAgentsMarketStore = create<AgentsMarketState>((set, get) => ({
  agents: [],
  updatedAt: 0,
  isLoading: false,
  isRefreshing: false,
  error: null,
  activeGroup: "",
  installingIds: [],

  hydrate: async () => {
    // 1. 先读盘
    let cache: MarketCache | null = null;
    try {
      cache = await readConfig<MarketCache>(CACHE_FILE);
    } catch {
      cache = null; // 首次运行无缓存，正常
    }

    if (cache && Array.isArray(cache.agents)) {
      set({ agents: cache.agents, updatedAt: cache.updatedAt || 0 });
    }

    // 2. 始终刷新内置资源，不阻塞 UI；替换 agents-zh.json 后下次启动即可生效。
    void get().refresh(true);
  },

  refresh: async (force = false) => {
    if (get().isRefreshing) return;
    if (!force && get().updatedAt > 0) return;

    // 无缓存时显示前台加载态，有缓存时仅后台刷新
    const hasCache = get().agents.length > 0;
    set({ isRefreshing: true, isLoading: !hasCache, error: null });

    try {
      const agents = await fetchTextPrompts();
      const updatedAt = Date.now();
      set({ agents, updatedAt });

      // 持久化
      try {
        await writeConfig(CACHE_FILE, { updatedAt, agents } satisfies MarketCache);
      } catch (error) {
        console.error("持久化助手广场缓存失败:", error);
      }
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "加载助手广场失败",
      });
    } finally {
      set({ isRefreshing: false, isLoading: false });
    }
  },

  setActiveGroup: (group) => set({ activeGroup: group }),

  install: async (agent) => {
    if (get().installingIds.includes(agent.id)) return false;
    set((state) => ({ installingIds: [...state.installingIds, agent.id] }));

    try {
      // 生成唯一 id，避免与现有助手冲突
      const existingIds = new Set(
        useConfigStore.getState().agents.map((a) => a.id),
      );
      let id = `market-${toSlug(agent.name)}`;
      let suffix = 1;
      while (existingIds.has(id)) {
        id = `market-${toSlug(agent.name)}-${suffix++}`;
      }

      // 新装助手沿用当前默认供应商作为运行配置骨架，仅覆盖身份与提示词
      const defaultProvider =
        useConfigStore.getState().providers.defaultProvider;
      const newAgent: AgentConfig = {
        id,
        name: agent.name,
        description: agent.description,
        version: "1.0.0",
        type: "custom",
        avatar: agent.emoji,
        metadata: {
          author: "助手广场",
          category: agent.group[0] ?? "general",
          tags: agent.group,
        },
        config: {
          systemPrompt: agent.prompt,
          provider: defaultProvider,
          model: "",
          enabledSkills: [],
        },
      };

      await useConfigStore.getState().addAgent(newAgent);
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "添加助手失败" });
      return false;
    } finally {
      set((state) => ({
        installingIds: state.installingIds.filter((id) => id !== agent.id),
      }));
    }
  },

  clearError: () => set({ error: null }),
}));
