// 技能广场 Store —— SkillsMP 搜索、分类缓存与安装
// src/stores/skills-market-store.ts
//
// SkillsMP 仅有一个搜索端点，因此「分类浏览」用预置分类关键词驱动搜索实现。
// 启动时全量拉取所有分类并持久化到本地；超过 24 小时则后台自动刷新。

import { create } from "zustand";
import {
  readConfig,
  searchMarketSkills,
  writeConfig,
  type MarketSkill,
} from "@/lib/electron-api";
import { skillLoader } from "@/lib/skill-loader";
import { useConfigStore } from "./config-store";

// 预置分类：label 展示，query 作搜索词（q 必填），category 作 API 过滤 slug
export interface MarketCategory {
  id: string;
  label: string;
  icon: string;
  query: string;
  category: string;
}

// SkillsMP 真实顶级分类（slug 取自 skillsmp.com/categories/{slug}）
export const MARKET_CATEGORIES: MarketCategory[] = [
  { id: "tools", label: "工具", icon: "🛠️", query: "tools", category: "tools" },
  { id: "business", label: "商业", icon: "💼", query: "business", category: "business" },
  { id: "development", label: "开发", icon: "💻", query: "development", category: "development" },
  { id: "testing-security", label: "测试与安全", icon: "🔒", query: "testing security", category: "testing-security" },
  { id: "data-ai", label: "数据与 AI", icon: "📊", query: "data ai", category: "data-ai" },
  { id: "devops", label: "DevOps", icon: "⚙️", query: "devops", category: "devops" },
  { id: "documentation", label: "文档", icon: "📄", query: "documentation", category: "documentation" },
  { id: "content-media", label: "内容与媒体", icon: "🎬", query: "content media", category: "content-media" },
  { id: "research", label: "研究", icon: "🔬", query: "research", category: "research" },
  { id: "lifestyle", label: "生活方式", icon: "🌿", query: "lifestyle", category: "lifestyle" },
  { id: "databases", label: "数据库", icon: "🗄️", query: "database", category: "databases" },
  { id: "blockchain", label: "区块链", icon: "⛓️", query: "blockchain", category: "blockchain" },
];

// 本地缓存文件名（存于配置目录）与有效期
const CACHE_FILE = "skills-market-cache.json";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 小时

interface MarketCache {
  updatedAt: number;
  // 按分类 id 分桶的技能列表
  byCategory: Record<string, MarketSkill[]>;
}

interface SkillsMarketState {
  // 各分类缓存数据
  byCategory: Record<string, MarketSkill[]>;
  updatedAt: number;
  // 自定义搜索结果（不入分类缓存）
  searchResults: MarketSkill[] | null;
  searchQuery: string;

  isLoading: boolean; // 当前视图是否在加载（分类切换/搜索）
  isRefreshing: boolean; // 后台全量刷新中
  error: string | null;
  activeCategory: string; // 当前分类 id；自定义搜索时为 ""
  installingIds: string[];

  // 启动时调用：读盘 + 必要时后台刷新
  hydrate: () => Promise<void>;
  // 全量拉取所有分类并持久化
  refreshAll: (force?: boolean) => Promise<void>;
  // 切换分类（优先用缓存，无缓存则单独拉取）
  loadCategory: (categoryId: string) => Promise<void>;
  // 自定义关键词搜索
  searchByQuery: (query: string) => Promise<void>;
  // 安装到本地 custom 技能目录
  installSkill: (skill: MarketSkill) => Promise<boolean>;
  clearError: () => void;
}

// 拉取单个分类（失败返回 null，便于全量刷新跳过个别失败项）
async function fetchCategory(
  category: MarketCategory,
  apiKey?: string,
): Promise<MarketSkill[] | null> {
  try {
    const result = await searchMarketSkills({
      query: category.query,
      category: category.category,
      apiKey,
      sortBy: "stars",
      limit: 30,
    });
    return result.skills;
  } catch (error) {
    console.error(`拉取分类失败: ${category.id}`, error);
    return null;
  }
}

export const useSkillsMarketStore = create<SkillsMarketState>((set, get) => ({
  byCategory: {},
  updatedAt: 0,
  searchResults: null,
  searchQuery: "",
  isLoading: false,
  isRefreshing: false,
  error: null,
  activeCategory: "",
  installingIds: [],

  hydrate: async () => {
    // 1. 先尝试读盘
    let cache: MarketCache | null = null;
    try {
      cache = await readConfig<MarketCache>(CACHE_FILE);
    } catch {
      cache = null; // 首次运行无缓存文件，正常
    }

    if (cache && cache.byCategory) {
      set({ byCategory: cache.byCategory, updatedAt: cache.updatedAt || 0 });
    }

    // 2. 判断是否过期（或无缓存）→ 后台刷新，不阻塞 UI
    const age = Date.now() - (cache?.updatedAt ?? 0);
    if (!cache || age > MAX_AGE_MS) {
      void get().refreshAll(true);
    }
  },

  refreshAll: async (force = false) => {
    if (get().isRefreshing) return;
    const age = Date.now() - get().updatedAt;
    if (!force && age <= MAX_AGE_MS) return; // 未过期则不刷新

    set({ isRefreshing: true, error: null });
    const apiKey = useConfigStore.getState().settings.skillsApiKey;
    const next: Record<string, MarketSkill[]> = { ...get().byCategory };

    try {
      // 顺序拉取，避免触发速率限制
      for (const category of MARKET_CATEGORIES) {
        const skills = await fetchCategory(category, apiKey);
        if (skills) {
          next[category.id] = skills;
          // 边拉边更新，让 UI 渐进呈现
          set({ byCategory: { ...next } });
        }
      }

      const updatedAt = Date.now();
      set({ byCategory: next, updatedAt });

      // 持久化到本地
      const cache: MarketCache = { updatedAt, byCategory: next };
      try {
        await writeConfig(CACHE_FILE, cache);
      } catch (error) {
        console.error("持久化技能广场缓存失败:", error);
      }
    } finally {
      set({ isRefreshing: false });
    }
  },

  loadCategory: async (categoryId) => {
    const category = MARKET_CATEGORIES.find((c) => c.id === categoryId);
    if (!category) return;

    // 退出自定义搜索态，切到分类态
    set({ activeCategory: categoryId, searchResults: null, error: null });

    // 已有缓存：直接展示，不再请求
    if (get().byCategory[categoryId]?.length) {
      return;
    }

    // 无缓存：单独拉取该分类
    set({ isLoading: true });
    try {
      const apiKey = useConfigStore.getState().settings.skillsApiKey;
      const skills = await fetchCategory(category, apiKey);
      if (skills) {
        set((state) => ({
          byCategory: { ...state.byCategory, [categoryId]: skills },
        }));
      } else {
        set({ error: "加载该分类失败，请稍后重试。" });
      }
    } finally {
      set({ isLoading: false });
    }
  },

  searchByQuery: async (query) => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;

    set({
      isLoading: true,
      error: null,
      activeCategory: "",
      searchQuery: trimmed,
    });
    try {
      const apiKey = useConfigStore.getState().settings.skillsApiKey;
      const result = await searchMarketSkills({
        query: trimmed,
        apiKey,
        sortBy: "stars",
        limit: 30,
      });
      set({ searchResults: result.skills, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        searchResults: [],
        error: error instanceof Error ? error.message : "搜索技能失败",
      });
    }
  },

  installSkill: async (skill) => {
    if (get().installingIds.includes(skill.id)) return false;
    set((state) => ({ installingIds: [...state.installingIds, skill.id] }));

    try {
      if (!skill.repoUrl) {
        throw new Error("该技能缺少 Git 仓库地址，无法从云端安装");
      }
      const success = await skillLoader.installSkillFromGit(skill.repoUrl);
      if (!success) {
        throw new Error("安装技能失败，请检查仓库地址和 SKILL.md");
      }
      return true;
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "安装技能失败" });
      return false;
    } finally {
      set((state) => ({
        installingIds: state.installingIds.filter((id) => id !== skill.id),
      }));
    }
  },

  clearError: () => set({ error: null }),
}));
