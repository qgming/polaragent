// 团队监控 Store —— 管理团队会话的监控数据

import { create } from "zustand";

// 待办项（复用 task-monitor-store 的类型）
export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
}

// 产物项（复用 task-monitor-store 的类型）
export interface ArtifactItem {
  // 以路径为唯一键，重复写入同一文件只更新时间
  path: string;
  name: string;
  kind: "final" | "working";
  updatedAt: number;
}

// 团队会话的监控数据
export interface TeamMonitorData {
  // 待办列表（与普通对话一致）
  todos: TodoItem[];
  // 产物列表（与普通对话一致）
  artifacts: ArtifactItem[];
  // 工作目录
  workingDir?: string;
}

interface TeamMonitorState {
  // 按 threadId 索引
  byThread: Record<string, TeamMonitorData>;

  // 获取某会话的监控数据
  getMonitor: (threadId: string) => TeamMonitorData;

  // 待办和产物的更新方法
  updateTodos: (threadId: string, todos: TodoItem[]) => void;
  updateArtifacts: (threadId: string, artifacts: ArtifactItem[]) => void;
  addArtifact: (
    threadId: string,
    artifact: Omit<ArtifactItem, "updatedAt">,
  ) => void;
  removeArtifact: (threadId: string, path: string) => void;
  removeArtifactsUnderPath: (threadId: string, path: string) => void;
  setWorkingDir: (threadId: string, dir: string) => void;
}

const EMPTY_MONITOR: TeamMonitorData = {
  todos: [],
  artifacts: [],
};

export const useTeamMonitorStore = create<TeamMonitorState>((set, get) => ({
  byThread: {},

  getMonitor: (threadId) => {
    return get().byThread[threadId] ?? EMPTY_MONITOR;
  },

  updateTodos: (threadId, todos) =>
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...(state.byThread[threadId] ?? EMPTY_MONITOR),
          todos,
        },
      },
    })),

  updateArtifacts: (threadId, artifacts) =>
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...(state.byThread[threadId] ?? EMPTY_MONITOR),
          artifacts,
        },
      },
    })),

  addArtifact: (threadId, artifact) =>
    set((state) => {
      const monitor = state.byThread[threadId] ?? EMPTY_MONITOR;
      const existing = monitor.artifacts.findIndex(
        (item) => item.path === artifact.path,
      );
      const next: ArtifactItem = { ...artifact, updatedAt: Date.now() };
      const artifacts =
        existing >= 0
          ? monitor.artifacts.map((item, index) =>
              index === existing ? next : item,
            )
          : [...monitor.artifacts, next];

      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...monitor,
            artifacts,
          },
        },
      };
    }),

  removeArtifact: (threadId, path) =>
    set((state) => {
      const monitor = state.byThread[threadId] ?? EMPTY_MONITOR;
      const artifacts = monitor.artifacts.filter((item) => item.path !== path);
      if (artifacts.length === monitor.artifacts.length) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...monitor,
            artifacts,
          },
        },
      };
    }),

  removeArtifactsUnderPath: (threadId, path) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${normalized}/`;
    set((state) => {
      const monitor = state.byThread[threadId] ?? EMPTY_MONITOR;
      const artifacts = monitor.artifacts.filter((item) => {
        const itemPath = item.path.replace(/\\/g, "/").replace(/\/+$/, "");
        return itemPath !== normalized && !itemPath.startsWith(prefix);
      });
      if (artifacts.length === monitor.artifacts.length) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...monitor,
            artifacts,
          },
        },
      };
    });
  },

  setWorkingDir: (threadId, dir) =>
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...(state.byThread[threadId] ?? EMPTY_MONITOR),
          workingDir: dir,
        },
      },
    })),
}));
