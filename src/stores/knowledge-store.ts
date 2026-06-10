// 知识库状态管理
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { KnowledgeBase, KnowledgeFile } from "@/lib/knowledge";
import {
  createKnowledgeBase,
  updateKnowledgeBase,
  addFilesToKnowledge,
  removeFileFromKnowledge,
  getKnowledgeFiles,
  rebuildKnowledge,
  deleteKnowledge,
  listKnowledge,
  isElectronRuntime,
  checkFilesCompatibility,
  reembedIncompatibleFiles,
} from "@/lib/knowledge";
import { useConfigStore } from "./config-store";

interface KnowledgeState {
  // 知识库列表
  knowledgeBases: KnowledgeBase[];
  // 当前选中的知识库 ID
  currentKbId: string | null;
  // 当前知识库的文件列表
  currentFiles: KnowledgeFile[];
  // 加载状态
  isLoading: boolean;
  error: string | null;

  // 初始化：从主进程加载知识库列表
  loadKnowledgeBases: () => Promise<void>;

  // 创建空知识库
  createKnowledgeBase: (params: {
    name: string;
    description?: string;
    chunkSize?: number;
    overlap?: number;
  }) => Promise<KnowledgeBase>;

  // 更新知识库配置
  updateKnowledgeBase: (
    kbId: string,
    updates: Partial<{
      name: string;
      description: string;
      enabled: boolean;
      chunkSize: number;
      overlap: number;
    }>,
  ) => Promise<void>;

  // 删除知识库
  deleteKnowledgeBase: (kbId: string) => Promise<void>;

  // 设置当前知识库并加载其文件
  setCurrentKnowledgeBase: (kbId: string | null) => Promise<void>;

  // 添加文件到当前知识库
  addFiles: (filePaths: string[]) => Promise<void>;

  // 从当前知识库删除文件
  removeFile: (fileId: string) => Promise<void>;

  // 重建当前知识库索引
  rebuildCurrentKnowledgeBase: () => Promise<void>;

  // 检查文件兼容性
  checkCompatibility: () => Promise<void>;

  // 重新嵌入不兼容的文件
  reembedIncompatible: () => Promise<void>;

  // 清除错误
  clearError: () => void;
}

function createId(): string {
  return `kb-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function requireElectron() {
  if (!isElectronRuntime()) {
    throw new Error("此功能仅在 Electron 环境下可用");
  }
}

export const useKnowledgeStore = create<KnowledgeState>()(
  persist(
    (set, get) => ({
      knowledgeBases: [],
      currentKbId: null,
      currentFiles: [],
      isLoading: false,
      error: null,

      loadKnowledgeBases: async () => {
        if (!isElectronRuntime()) {
          set({ knowledgeBases: [], isLoading: false });
          return;
        }
        set({ isLoading: true, error: null });
        try {
          const list = await listKnowledge();
          set({ knowledgeBases: list, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "加载知识库失败",
            isLoading: false,
          });
        }
      },

      createKnowledgeBase: async (params) => {
        requireElectron();
        set({ isLoading: true, error: null });
        try {
          const kbId = createId();
          const result = await createKnowledgeBase({
            kbId,
            name: params.name,
            description: params.description,
            chunkSize: params.chunkSize ?? 512,
            overlap: params.overlap ?? 50,
          });

          set((state) => ({
            knowledgeBases: [...state.knowledgeBases, result.knowledgeBase],
            isLoading: false,
          }));

          return result.knowledgeBase;
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "创建知识库失败",
            isLoading: false,
          });
          throw error;
        }
      },

      updateKnowledgeBase: async (kbId, updates) => {
        requireElectron();
        set({ isLoading: true, error: null });
        try {
          const result = await updateKnowledgeBase({ kbId, updates });
          set((state) => ({
            knowledgeBases: state.knowledgeBases.map((kb) =>
              kb.id === kbId ? result.knowledgeBase : kb,
            ),
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "更新知识库失败",
            isLoading: false,
          });
          throw error;
        }
      },

      deleteKnowledgeBase: async (kbId) => {
        requireElectron();
        set({ isLoading: true, error: null });
        try {
          await deleteKnowledge(kbId);
          set((state) => ({
            knowledgeBases: state.knowledgeBases.filter((kb) => kb.id !== kbId),
            currentKbId: state.currentKbId === kbId ? null : state.currentKbId,
            currentFiles: state.currentKbId === kbId ? [] : state.currentFiles,
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "删除知识库失败",
            isLoading: false,
          });
          throw error;
        }
      },

      setCurrentKnowledgeBase: async (kbId) => {
        requireElectron();
        console.log("setCurrentKnowledgeBase called with kbId:", kbId);
        if (kbId === null) {
          set({ currentKbId: null, currentFiles: [] });
          return;
        }

        set({ isLoading: true, error: null, currentKbId: kbId });
        try {
          console.log("calling getKnowledgeFiles with kbId:", kbId);
          const files = await getKnowledgeFiles(kbId);
          set({ currentFiles: files, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "加载文件列表失败",
            isLoading: false,
          });
        }
      },

      addFiles: async (filePaths) => {
        requireElectron();
        const { currentKbId, knowledgeBases } = get();
        if (!currentKbId) {
          set({ error: "请先选择一个知识库" });
          return;
        }

        const kb = knowledgeBases.find((k) => k.id === currentKbId);
        if (!kb) {
          set({ error: "知识库不存在" });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const embedding = useConfigStore.getState().settings.knowledge?.embedding;
          if (!embedding || !embedding.apiKey) {
            throw new Error("请先在设置中配置嵌入模型");
          }

          const result = await addFilesToKnowledge({
            kbId: currentKbId,
            filePaths,
            config: {
              chunkSize: kb.chunkSize,
              overlap: kb.overlap,
              embedding: {
                apiKey: embedding.apiKey,
                baseURL: embedding.baseURL,
                model: embedding.model,
                dimension: embedding.dimension,
              },
            },
          });

          // 更新知识库统计信息
          set((state) => ({
            knowledgeBases: state.knowledgeBases.map((k) =>
              k.id === currentKbId
                ? {
                    ...k,
                    fileCount: result.totalFiles,
                    chunkCount: result.totalChunks,
                    updatedAt: Date.now(),
                  }
                : k,
            ),
            currentFiles: [...state.currentFiles, ...result.addedFiles],
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "添加文件失败",
            isLoading: false,
          });
          throw error;
        }
      },

      removeFile: async (fileId) => {
        requireElectron();
        const { currentKbId } = get();
        if (!currentKbId) {
          set({ error: "请先选择一个知识库" });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          await removeFileFromKnowledge(currentKbId, fileId);

          // 重新加载文件列表和知识库统计
          const files = await getKnowledgeFiles(currentKbId);
          const list = await listKnowledge();
          const updatedKb = list.find((kb) => kb.id === currentKbId);

          set((state) => ({
            knowledgeBases: updatedKb
              ? state.knowledgeBases.map((kb) => (kb.id === currentKbId ? updatedKb : kb))
              : state.knowledgeBases,
            currentFiles: files,
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "删除文件失败",
            isLoading: false,
          });
          throw error;
        }
      },

      rebuildCurrentKnowledgeBase: async () => {
        requireElectron();
        const { currentKbId } = get();
        if (!currentKbId) {
          set({ error: "请先选择一个知识库" });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const embedding = useConfigStore.getState().settings.knowledge?.embedding;
          if (!embedding || !embedding.apiKey) {
            throw new Error("请先在设置中配置嵌入模型");
          }

          const result = await rebuildKnowledge({
            kbId: currentKbId,
            config: {
              embedding: {
                apiKey: embedding.apiKey,
                baseURL: embedding.baseURL,
                model: embedding.model,
                dimension: embedding.dimension,
              },
            },
          });

          // 重新加载数据
          const files = await getKnowledgeFiles(currentKbId);
          set((state) => ({
            knowledgeBases: state.knowledgeBases.map((kb) =>
              kb.id === currentKbId
                ? {
                    ...kb,
                    fileCount: result.fileCount,
                    chunkCount: result.chunkCount,
                    updatedAt: Date.now(),
                  }
                : kb,
            ),
            currentFiles: files,
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "重建索引失败",
            isLoading: false,
          });
          throw error;
        }
      },

      checkCompatibility: async () => {
        requireElectron();
        const { currentKbId } = get();
        if (!currentKbId) return;

        try {
          const embedding = useConfigStore.getState().settings.knowledge?.embedding;
          if (!embedding || !embedding.apiKey) return;

          const files = await checkFilesCompatibility(currentKbId, {
            embedding: {
              apiKey: embedding.apiKey,
              baseURL: embedding.baseURL,
              model: embedding.model,
              dimension: embedding.dimension,
            },
          });

          set({ currentFiles: files });
        } catch (error) {
          console.error("检查兼容性失败:", error);
        }
      },

      reembedIncompatible: async () => {
        requireElectron();
        const { currentKbId } = get();
        if (!currentKbId) {
          set({ error: "请先选择一个知识库" });
          return;
        }

        set({ isLoading: true, error: null });
        try {
          const embedding = useConfigStore.getState().settings.knowledge?.embedding;
          if (!embedding || !embedding.apiKey) {
            throw new Error("请先在设置中配置嵌入模型");
          }

          await reembedIncompatibleFiles({
            kbId: currentKbId,
            config: {
              embedding: {
                apiKey: embedding.apiKey,
                baseURL: embedding.baseURL,
                model: embedding.model,
                dimension: embedding.dimension,
              },
            },
          });

          // 重新加载数据
          const files = await getKnowledgeFiles(currentKbId);
          const list = await listKnowledge();
          const updatedKb = list.find((kb) => kb.id === currentKbId);

          set((state) => ({
            knowledgeBases: updatedKb
              ? state.knowledgeBases.map((kb) => (kb.id === currentKbId ? updatedKb : kb))
              : state.knowledgeBases,
            currentFiles: files,
            isLoading: false,
          }));
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : "重新嵌入失败",
            isLoading: false,
          });
          throw error;
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: "polaragent-knowledge",
      partialize: (state) => ({
        currentKbId: state.currentKbId,
      }),
    },
  ),
);
