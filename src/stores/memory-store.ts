import { create } from "zustand";
import type {
  ListMemoryRequest,
  MemoryItem,
  MemoryStats,
  MemoryType,
} from "@/lib/memory";
import {
  archiveMemory,
  createMemory,
  deleteMemory,
  getMemoryStats,
  isElectronRuntime,
  listMemories,
  memoryApiConfigFromSettings,
  rebuildMemory,
  updateMemory,
} from "@/lib/memory";
import { useConfigStore } from "./config-store";

interface MemoryState {
  memories: MemoryItem[];
  stats: MemoryStats | null;
  isLoading: boolean;
  isRebuilding: boolean;
  error: string | null;
  lastAutoWriteError: string | null;

  loadMemories: (request?: ListMemoryRequest) => Promise<void>;
  loadStats: () => Promise<void>;
  createManualMemory: (params: {
    content: string;
    type: MemoryType;
    scope: "global" | "project";
    projectKey?: string;
    sourceThreadId?: string;
    tags?: string[];
  }) => Promise<void>;
  updateMemoryItem: (
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "type" | "confidence" | "tags" | "archived">>,
  ) => Promise<void>;
  archiveMemoryItem: (id: string, archived?: boolean) => Promise<void>;
  deleteMemoryItem: (id: string) => Promise<void>;
  rebuildMemoryIndex: (scope?: "global" | "project") => Promise<void>;
  setLastAutoWriteError: (message: string | null) => void;
  clearError: () => void;
}

function requireMemoryConfig() {
  const settings = useConfigStore.getState().settings;
  const config = memoryApiConfigFromSettings(settings);
  if (!config) {
    throw new Error("请先在设置中配置嵌入模型");
  }
  return {
    config,
  };
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memories: [],
  stats: null,
  isLoading: false,
  isRebuilding: false,
  error: null,
  lastAutoWriteError: null,

  loadMemories: async (request = {}) => {
    if (!isElectronRuntime()) {
      set({ memories: [], isLoading: false });
      return;
    }
    set({ isLoading: true, error: null });
    try {
      const memories = await listMemories(request);
      set({ memories, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "加载记忆失败",
        isLoading: false,
      });
    }
  },

  loadStats: async () => {
    if (!isElectronRuntime()) {
      set({ stats: null });
      return;
    }
    try {
      const stats = await getMemoryStats();
      set({ stats });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : "加载记忆统计失败" });
    }
  },

  createManualMemory: async (params) => {
    const { config } = requireMemoryConfig();
    set({ isLoading: true, error: null });
    try {
      await createMemory({
        memory: {
          content: params.content,
          type: params.type,
          scope: params.scope,
          projectKey: params.projectKey,
          sourceThreadId: params.sourceThreadId,
          confidence: 1,
          tags: params.tags ?? [],
        },
        config,
      });
      await Promise.all([get().loadMemories({ includeArchived: true }), get().loadStats()]);
      set({ isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "创建记忆失败",
        isLoading: false,
      });
      throw error;
    }
  },

  updateMemoryItem: async (id, updates) => {
    const { config } = requireMemoryConfig();
    set({ isLoading: true, error: null });
    try {
      await updateMemory({ id, updates, config });
      await Promise.all([get().loadMemories({ includeArchived: true }), get().loadStats()]);
      set({ isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "更新记忆失败",
        isLoading: false,
      });
      throw error;
    }
  },

  archiveMemoryItem: async (id, archived = true) => {
    set({ isLoading: true, error: null });
    try {
      await archiveMemory({ id, archived });
      await Promise.all([get().loadMemories({ includeArchived: true }), get().loadStats()]);
      set({ isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "关闭记忆失败",
        isLoading: false,
      });
      throw error;
    }
  },

  deleteMemoryItem: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await deleteMemory({ id });
      await Promise.all([get().loadMemories({ includeArchived: true }), get().loadStats()]);
      set({ isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "删除记忆失败",
        isLoading: false,
      });
      throw error;
    }
  },

  rebuildMemoryIndex: async (scope) => {
    const { config } = requireMemoryConfig();
    set({ isRebuilding: true, error: null });
    try {
      await rebuildMemory({ config, scope });
      await get().loadStats();
      set({ isRebuilding: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : "重建记忆索引失败",
        isRebuilding: false,
      });
      throw error;
    }
  },

  setLastAutoWriteError: (message) => set({ lastAutoWriteError: message }),
  clearError: () => set({ error: null }),
}));
