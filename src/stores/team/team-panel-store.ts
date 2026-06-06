// 团队面板 Store —— 管理团队聊天页右侧面板的开合状态
// src/stores/team-panel-store.ts

import { create } from "zustand";

interface TeamPanelState {
  // 面板是否打开（按 threadId 记录）
  openByThread: Record<string, boolean>;
  // 是否有监控数据（决定默认展开）
  hasDataByThread: Record<string, boolean>;

  // 切换面板开合
  togglePanel: (threadId: string) => void;

  // 设置是否有数据
  setHasData: (threadId: string, hasData: boolean) => void;

  // 重置为默认状态（根据是否有数据决定）
  resetOverride: (threadId: string) => void;
}

export const useTeamPanelStore = create<TeamPanelState>((set) => ({
  openByThread: {},
  hasDataByThread: {},

  togglePanel: (threadId) =>
    set((state) => ({
      openByThread: {
        ...state.openByThread,
        [threadId]: !state.openByThread[threadId],
      },
    })),

  setHasData: (threadId, hasData) =>
    set((state) => ({
      hasDataByThread: {
        ...state.hasDataByThread,
        [threadId]: hasData,
      },
    })),

  resetOverride: (threadId) =>
    set((state) => ({
      openByThread: {
        ...state.openByThread,
        [threadId]: state.hasDataByThread[threadId] ?? false,
      },
    })),
}));
