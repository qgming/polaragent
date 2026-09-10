// 设置模态窗 UI 状态
// src/stores/settings-ui-store.ts

import { create } from "zustand";

/** 设置分区 */
export type SettingsSection =
  | "general"
  | "models"
  | "personal"
  | "about";

interface SettingsUiState {
  settingsOpen: boolean;
  activeSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  setActiveSection: (section: SettingsSection) => void;
}

export const useSettingsUiStore = create<SettingsUiState>((set) => ({
  settingsOpen: false,
  activeSection: "general",
  openSettings: (section = "general") => set({ settingsOpen: true, activeSection: section }),
  closeSettings: () => set({ settingsOpen: false }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setActiveSection: (section) => set({ activeSection: section }),
}));
