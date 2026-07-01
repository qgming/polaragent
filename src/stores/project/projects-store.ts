// 项目配置 Store —— 镜像 config-store 的 teams CRUD
//
// 项目配置以本地文件为准（{dataDir}/projects/<id>.json，经 Electron API 读写）。
// 这里只做内存镜像 + 增删改，落盘交给 Electron API。

import { create } from "zustand";

import {
  getDataDir,
  fileExists,
  readFile,
  writeFile,
  createDirectory,
  deleteFile,
  listDirectoryEntries,
} from "@/lib/electron/electron-api";
import type { ProjectConfig } from "@/types/config";
import { pMap, LOCAL_IO_CONCURRENCY } from "@/lib/concurrency";

interface ProjectsState {
  projects: ProjectConfig[];
  isLoading: boolean;
  error: string | null;

  loadProjects: () => Promise<void>;
  addProject: (project: ProjectConfig) => Promise<void>;
  updateProject: (id: string, updates: Partial<ProjectConfig>) => Promise<void>;
  removeProject: (id: string) => Promise<void>;
  clearError: () => void;
}

// 列出所有项目配置 ID
async function listProjects(): Promise<string[]> {
  const dataDir = await getDataDir();
  const projectsDir = `${dataDir}/projects`;
  if (!(await fileExists(projectsDir))) {
    return [];
  }
  try {
    const entries = await listDirectoryEntries(projectsDir);
    return entries
      .filter((e) => !e.isDir && e.name.endsWith(".json"))
      .map((e) => e.name.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// 读取项目配置
async function readProjectConfig<T = any>(projectId: string): Promise<T | null> {
  try {
    const dataDir = await getDataDir();
    return JSON.parse(await readFile(`${dataDir}/projects/${projectId}.json`)) as T;
  } catch (error) {
    console.warn(`读取项目配置失败 ${projectId}:`, error);
    return null;
  }
}

// 写入项目配置
async function writeProjectConfig(projectId: string, content: any): Promise<void> {
  const dataDir = await getDataDir();
  const projectsDir = `${dataDir}/projects`;
  if (!(await fileExists(projectsDir))) {
    await createDirectory(projectsDir);
  }
  await writeFile(
    `${projectsDir}/${projectId}.json`,
    JSON.stringify(content, null, 2),
  );
}

// 删除项目配置
async function deleteProjectConfig(projectId: string): Promise<void> {
  const dataDir = await getDataDir();
  const path = `${dataDir}/projects/${projectId}.json`;
  if (await fileExists(path)) {
    await deleteFile(path);
  }
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  projects: [],
  isLoading: false,
  error: null,

  // 加载项目列表 —— 完全以本地文件为准
  loadProjects: async () => {
    set({ isLoading: true, error: null });
    try {
      const ids = await listProjects();
      const loaded = await pMap(
        ids,
        (id) => readProjectConfig<ProjectConfig>(id),
        { concurrency: LOCAL_IO_CONCURRENCY },
      );
      set({ projects: loaded.filter(Boolean) as ProjectConfig[] });
    } catch (error) {
      console.warn("无法加载项目", error);
      set({ projects: [] });
    } finally {
      set({ isLoading: false });
    }
  },

  // 添加项目
  addProject: async (project) => {
    await writeProjectConfig(project.id, project);
    set((state) => ({ projects: [...state.projects, project] }));
  },

  // 更新项目 —— 在 set 回调内合并更新，避免并发调用时基于旧快照覆盖
  updateProject: async (id, updates) => {
    // 先尝试在 set 回调内获取最新状态合并，确保不丢失其他并发更新
    let updated: ProjectConfig | undefined;
    set((state) => {
      const current = state.projects.find((p) => p.id === id);
      if (!current) return state;
      updated = { ...current, ...updates, updatedAt: Date.now() };
      return {
        projects: state.projects.map((p) => (p.id === id ? updated! : p)),
      };
    });
    if (!updated) return;
    await writeProjectConfig(id, updated);
  },

  // 删除项目
  removeProject: async (id) => {
    await deleteProjectConfig(id);
    set((state) => ({ projects: state.projects.filter((p) => p.id !== id) }));
  },

  clearError: () => {
    set({ error: null });
  },
}));
