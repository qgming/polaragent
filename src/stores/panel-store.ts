// 对话区右侧「任务监控」面板的开合状态
// src/stores/panel-store.ts
//
// 该状态需在 TitleBar（顶部栏的开合按钮）与 ChatPage（实际渲染面板）间共享，
// 故提取为独立 store。开合规则：用户手动切换优先（override），否则跟随
// 「该会话是否已产生监控数据」(hasData) 自动展开。

import { create } from "zustand";

interface PanelState {
  // 用户手动开合；null 表示未手动干预，跟随 hasData
  override: boolean | null;
  // 当前会话是否已产生监控数据（由 ChatPage 同步写入）
  hasData: boolean;

  // 顶部栏/页头按钮切换：基于当前最终态取反并固化为手动态
  toggle: () => void;
  // ChatPage 同步「有无监控数据」
  setHasData: (hasData: boolean) => void;
  // 切换会话时重置手动态，回到「有内容才展开」
  resetOverride: () => void;
}

export const usePanelStore = create<PanelState>((set, get) => ({
  override: null,
  hasData: false,

  toggle: () => {
    const { override, hasData } = get();
    const current = override ?? hasData;
    set({ override: !current });
  },

  setHasData: (hasData) => set({ hasData }),

  resetOverride: () => set({ override: null }),
}));

// 派生：面板最终是否展开（订阅 override 与 hasData，变化时触发重渲染）
export function usePanelOpen(): boolean {
  const override = usePanelStore((state) => state.override);
  const hasData = usePanelStore((state) => state.hasData);
  return override ?? hasData;
}
