// 任务监控 Store
// src/stores/task-monitor-store.ts
//
// 驱动右侧「任务监控」面板的三个区域：
//   - 待办 (todos)：由 Agent 的 update_todos 工具写入
//   - 产物 (artifacts)：由 write_file 等文件工具调用聚合
//   - 步骤轨迹 (steps)：由 tool_execution_* 事件记录，供对话流折叠展示
//
// 所有数据按 threadId 分桶，切换会话时各自独立。

import { create } from "zustand";
import { toolDisplayName } from "@/ai/tools";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export type ArtifactKind = "final" | "working";

export interface ArtifactItem {
  // 以路径为唯一键，重复写入同一文件只更新时间
  path: string;
  name: string;
  kind: ArtifactKind;
  updatedAt: number;
}

export type StepStatus = "running" | "done" | "error";

export interface StepItem {
  id: string; // 对应 toolCallId
  toolName: string;
  label: string; // 单行人类可读结果，如「已更新待办 7 项」
  status: StepStatus;
  // 关联到某条 assistant 消息，便于在对话流中按消息分组折叠
  messageId?: string;
  createdAt: number;
}

interface ThreadMonitor {
  todos: TodoItem[];
  artifacts: ArtifactItem[];
  steps: StepItem[];
  workingDir?: string;
}

const emptyMonitor = (): ThreadMonitor => ({
  todos: [],
  artifacts: [],
  steps: [],
});

interface TaskMonitorState {
  byThread: Record<string, ThreadMonitor>;

  // 读取（始终返回稳定空对象，避免组件读到 undefined）
  getMonitor: (threadId: string) => ThreadMonitor;

  // 待办
  setTodos: (threadId: string, todos: TodoItem[]) => void;
  // 产物
  addArtifact: (threadId: string, artifact: Omit<ArtifactItem, "updatedAt">) => void;
  removeArtifact: (threadId: string, path: string) => void;
  removeArtifactsUnderPath: (threadId: string, path: string) => void;
  // 步骤轨迹
  startStep: (
    threadId: string,
    step: { id: string; toolName: string; messageId?: string },
  ) => void;
  finishStep: (
    threadId: string,
    stepId: string,
    update: { label: string; status: StepStatus },
  ) => void;
  // 工作目录
  setWorkingDir: (threadId: string, dir: string) => void;
  // 从持久化（jsonl 回读）恢复某会话的监控快照（待办 + 产物）
  hydrateThread: (
    threadId: string,
    snapshot: { todos: TodoItem[]; artifacts: ArtifactItem[] },
  ) => void;
  // 清空某会话监控数据
  clearThread: (threadId: string) => void;
}

const EMPTY: ThreadMonitor = emptyMonitor();

export const useTaskMonitorStore = create<TaskMonitorState>((set, get) => ({
  byThread: {},

  getMonitor: (threadId) => get().byThread[threadId] ?? EMPTY,

  setTodos: (threadId, todos) => {
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...(state.byThread[threadId] ?? emptyMonitor()),
          todos,
        },
      },
    }));
  },

  addArtifact: (threadId, artifact) => {
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
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
          [threadId]: { ...monitor, artifacts },
        },
      };
    });
  },

  removeArtifact: (threadId, path) => {
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
      const artifacts = monitor.artifacts.filter((item) => item.path !== path);
      if (artifacts.length === monitor.artifacts.length) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...monitor, artifacts },
        },
      };
    });
  },

  removeArtifactsUnderPath: (threadId, path) => {
    const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
    const prefix = `${normalized}/`;
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
      const artifacts = monitor.artifacts.filter((item) => {
        const itemPath = item.path.replace(/\\/g, "/").replace(/[\\/]+$/, "");
        return itemPath !== normalized && !itemPath.startsWith(prefix);
      });
      if (artifacts.length === monitor.artifacts.length) return {};
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...monitor, artifacts },
        },
      };
    });
  },

  startStep: (threadId, step) => {
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
      const item: StepItem = {
        id: step.id,
        toolName: step.toolName,
        messageId: step.messageId,
        label: toolDisplayName(step.toolName),
        status: "running",
        createdAt: Date.now(),
      };
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...monitor, steps: [...monitor.steps, item] },
        },
      };
    });
  },

  finishStep: (threadId, stepId, update) => {
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
      const steps = monitor.steps.map((step) =>
        step.id === stepId
          ? { ...step, label: update.label, status: update.status }
          : step,
      );
      return {
        byThread: {
          ...state.byThread,
          [threadId]: { ...monitor, steps },
        },
      };
    });
  },

  setWorkingDir: (threadId, dir) => {
    set((state) => ({
      byThread: {
        ...state.byThread,
        [threadId]: {
          ...(state.byThread[threadId] ?? emptyMonitor()),
          workingDir: dir,
        },
      },
    }));
  },

  clearThread: (threadId) => {
    set((state) => ({
      byThread: { ...state.byThread, [threadId]: emptyMonitor() },
    }));
  },

  hydrateThread: (threadId, snapshot) => {
    set((state) => {
      const monitor = state.byThread[threadId] ?? emptyMonitor();
      // 仅在该会话当前既无待办也无产物时回填，避免覆盖运行期已产生的数据
      if (monitor.todos.length > 0 || monitor.artifacts.length > 0) {
        return {};
      }
      return {
        byThread: {
          ...state.byThread,
          [threadId]: {
            ...monitor,
            todos: snapshot.todos,
            artifacts: snapshot.artifacts,
          },
        },
      };
    });
  },
}));
