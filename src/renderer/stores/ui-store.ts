import { create } from "zustand";

/** 设置弹窗内的分栏 */
export type SettingsSection =
  | "general"
  | "services"
  | "permissions"
  | "skills"
  | "personalization"
  | "about";

interface UiState {
  sidebarCollapsed: boolean;
  globalSearchOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  sessionSearchOpen: boolean;
  sessionSearchQuery: string;

  toggleSidebar(): void;
  openGlobalSearch(): void;
  closeGlobalSearch(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  openSessionSearch(): void;
  closeSessionSearch(): void;
  setSessionSearchQuery(query: string): void;
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarCollapsed: false,
  globalSearchOpen: false,
  settingsOpen: false,
  settingsSection: "general",
  sessionSearchOpen: false,
  sessionSearchQuery: "",

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  openGlobalSearch: () => set({ globalSearchOpen: true }),
  closeGlobalSearch: () => set({ globalSearchOpen: false }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? "general" }),
  closeSettings: () => set({ settingsOpen: false }),
  openSessionSearch: () => set({ sessionSearchOpen: true }),
  closeSessionSearch: () => set({ sessionSearchOpen: false }),
  setSessionSearchQuery: (query) => set({ sessionSearchQuery: query }),
}));
