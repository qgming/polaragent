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
  /** 待确认删除的会话 id（null = 无）；由侧栏渲染确认对话框 */
  pendingDeleteSessionId: string | null;
  /** 待确认的删除所对应的解决函数：确认与否决都要调它，否则适配器那边的 Promise 悬挂 */
  resolveDeleteSession: ((confirmed: boolean) => void) | null;

  toggleSidebar(): void;
  openGlobalSearch(): void;
  closeGlobalSearch(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  openSessionSearch(): void;
  closeSessionSearch(): void;
  setSessionSearchQuery(query: string): void;
  /**
   * 请求删除会话，返回用户是否确认。
   * 官方 thread-list 的 Delete 是会立刻执行的，删除又是不可撤销的磁盘操作，
   * 因此把确认拦在这里：确认框关闭前不真正删除。
   */
  requestDeleteSession(id: string): Promise<boolean>;
  /** 由确认对话框调用：记录用户选择并关闭对话框 */
  settleDeleteSession(confirmed: boolean): void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: false,
  globalSearchOpen: false,
  settingsOpen: false,
  settingsSection: "general",
  sessionSearchOpen: false,
  sessionSearchQuery: "",
  pendingDeleteSessionId: null,
  resolveDeleteSession: null,

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  openGlobalSearch: () => set({ globalSearchOpen: true }),
  closeGlobalSearch: () => set({ globalSearchOpen: false }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? "general" }),
  closeSettings: () => set({ settingsOpen: false }),
  openSessionSearch: () => set({ sessionSearchOpen: true }),
  closeSessionSearch: () => set({ sessionSearchOpen: false }),
  setSessionSearchQuery: (query) => set({ sessionSearchQuery: query }),

  requestDeleteSession: (id) =>
    new Promise<boolean>((resolve) => {
      // 上一个请求还没结算就再来一个（连点菜单）：先把旧的按否决收掉，避免悬挂
      get().resolveDeleteSession?.(false);
      set({ pendingDeleteSessionId: id, resolveDeleteSession: resolve });
    }),

  settleDeleteSession: (confirmed) => {
    const resolve = get().resolveDeleteSession;
    set({ pendingDeleteSessionId: null, resolveDeleteSession: null });
    resolve?.(confirmed);
  },
}));
