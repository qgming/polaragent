// Composer 扩展状态：附加文件 / 工作目录（发送前暂存）
// src/runtime/composer-extras-store.ts

import { create } from "zustand";

export interface ComposerExtrasState {
  filePaths: string[];
  workingDir: string;
  setFilePaths: (paths: string[]) => void;
  addFilePath: (path: string) => void;
  removeFilePath: (path: string) => void;
  setWorkingDir: (dir: string) => void;
  clear: () => void;
}

export const useComposerExtrasStore = create<ComposerExtrasState>((set) => ({
  filePaths: [],
  workingDir: "",
  setFilePaths: (paths) => set({ filePaths: paths }),
  addFilePath: (path) =>
    set((s) => ({
      filePaths: s.filePaths.includes(path) ? s.filePaths : [...s.filePaths, path],
    })),
  removeFilePath: (path) =>
    set((s) => ({ filePaths: s.filePaths.filter((p) => p !== path) })),
  setWorkingDir: (dir) => set({ workingDir: dir }),
  clear: () => set({ filePaths: [] }),
}));
