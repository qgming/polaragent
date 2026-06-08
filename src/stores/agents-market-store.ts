// 助手广场 Store —— 内置中文助手库的读取与安装
// src/stores/agents-market-store.ts
//
// 数据源为打包在 resources/market/agents/ 下的静态文件：
//   - index.json   分类索引（含分类名、emoji、计数，无 prompt，体积极小）
//   - cat-XXX.json  每个分类一个文件，存该分类下全部助手
// 因是内置静态资源（读盘+解析仅毫秒级），无需磁盘缓存与后台刷新：
// 启动读索引渲染分类 chip；切到某分类时按需读对应文件，仅缓存在内存，
// 同一会话内再次访问直接命中。重启后重新读取，永远与内置文件保持一致。

import { create } from "zustand";
import {
  fetchAgentIndex,
  fetchAgentCategory,
  type MarketAgent,
  type MarketAgentCategory,
} from "@/lib/electron/electron-api";
import type { AgentConfig } from "@/types/config";
import { useConfigStore } from "./config-store";

interface AgentsMarketState {
  categories: MarketAgentCategory[]; // 分类索引
  byCategory: Record<string, MarketAgent[]>; // 已加载分类的助手内存缓存（键为分类文件名）
  isLoading: boolean; // 索引加载中的前台态
  loadingFiles: string[]; // 正在加载的分类文件名
  error: string | null;
  activeGroup: string; // 当前分类筛选（分类显示名）
  installingIds: string[];

  // 启动时调用：加载分类索引
  hydrate: () => Promise<void>;
  // 切换分类筛选，并按需加载该分类的助手
  setActiveGroup: (group: string) => void;
  // 确保某分类的助手已加载（命中内存缓存则跳过）
  ensureCategory: (group: string) => Promise<void>;
  // 以某条提示词创建一个自定义助手（默认跟随模型设置路由）
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

// 根据分类显示名找到对应文件名
function fileOfGroup(categories: MarketAgentCategory[], group: string): string | null {
  return categories.find((c) => c.category === group)?.file ?? null;
}

export const useAgentsMarketStore = create<AgentsMarketState>((set, get) => ({
  categories: [],
  byCategory: {},
  isLoading: false,
  loadingFiles: [],
  error: null,
  activeGroup: "",
  installingIds: [],

  hydrate: async () => {
    if (get().categories.length > 0) return; // 已加载过索引
    set({ isLoading: true, error: null });
    try {
      const categories = await fetchAgentIndex();
      set({ categories });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "加载助手广场失败" });
    } finally {
      set({ isLoading: false });
    }
  },

  ensureCategory: async (group) => {
    const { categories, byCategory, loadingFiles } = get();
    const file = fileOfGroup(categories, group);
    if (!file) return; // 索引里没有该分类
    if (byCategory[file]) return; // 已在内存缓存
    if (loadingFiles.includes(file)) return; // 加载中

    set({ loadingFiles: [...loadingFiles, file], error: null });
    try {
      const agents = await fetchAgentCategory(file);
      set((state) => ({ byCategory: { ...state.byCategory, [file]: agents } }));
    } catch (error) {
      set({ error: error instanceof Error ? error.message : `加载分类「${group}」失败` });
    } finally {
      set((state) => ({ loadingFiles: state.loadingFiles.filter((f) => f !== file) }));
    }
  },

  setActiveGroup: (group) => {
    set({ activeGroup: group });
    void get().ensureCategory(group);
  },

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
          provider: "",
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
