import { create } from "zustand";

/** 右侧面板的视图。null = 还没选过，面板显示选择列表 */
export type RightPanelView = "review" | "files" | "sideChat" | "browser" | "terminal";

/**
 * 右侧面板五个视图的规范顺序，即面板内选择列表的顺序（与参考图一致）。
 * 加一个视图时只有这一处要改，选择列表与快捷键提示都读它。
 */
export const RIGHT_PANEL_VIEWS = [
  "review",
  "files",
  "sideChat",
  "browser",
  "terminal",
] as const satisfies readonly RightPanelView[];

/** 设置弹窗内的分栏 */
export type SettingsSection =
  | "general"
  | "services"
  | "mcp"
  | "skills"
  | "promptTemplates"
  | "personalization"
  | "data"
  | "about";

/**
 * 设置分类的规范顺序：左栏导航与搜索里的「设置」结果都按它渲染。
 * 两处各写一份列表时，删掉一个分类就会漏改另一处（搜索会打开一个没有面板的分栏）。
 */
export const SETTINGS_SECTIONS = [
  "general",
  "services",
  "mcp",
  "skills",
  "promptTemplates",
  "personalization",
  "data",
  "about",
] as const satisfies readonly SettingsSection[];
/**
 * 从搜索模态窗跳到某条消息。
 * token 只增不减：Thread 用它做「同一目标只滚一次」的去重键，
 * 若随清空归零，回到同一会话再点同一条消息就会撞上已消费的记录而不再滚动。
 */
export interface SearchJump {
  sessionId: string;
  messageId: string;
  token: number;
}

let searchJumpSeq = 0;

interface UiState {
  sidebarCollapsed: boolean;
  /** 搜索模态窗的显隐：侧栏搜索按钮与 Ctrl+K 共用同一个开关 */
  searchOpen: boolean;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /** 待定位的消息（null = 无）；由搜索模态窗的消息结果写入，Thread 消费后自行去重 */
  searchJump: SearchJump | null;
  /** 待确认删除的会话 id（null = 无）；由侧栏渲染确认对话框 */
  pendingDeleteSessionId: string | null;
  /** 待确认的删除所对应的解决函数：确认与否决都要调它，否则适配器那边的 Promise 悬挂 */
  resolveDeleteSession: ((confirmed: boolean) => void) | null;
  /** 正在编辑的用户消息 id（null = 未编辑）；由 ChatView 渲染编辑模态 */
  editingMessageId: string | null;

  /**
   * 右侧面板是否展开。与左侧栏同一套「展开 / 完全隐藏」两态（没有窄轨道）。
   * 收起**不清空** rightPanelView：面板是「藏起来」而不是「关掉」，
   * 再次展开回到用户上次在看的内容（与左侧栏停在同一份会话列表上同理）。
   */
  rightPanelOpen: boolean;
  /**
   * 当前查看的视图；**null = 还没选**，此时面板显示五个视图的选择列表。
   *
   * 为什么允许 null：面板的第一屏就该是「选一个内容」。顶栏那颗按钮直接展开面板、
   * 由面板自己列出五个入口，而不是再弹一个浮层菜单让人选第二次 ——
   * 这样「打开侧边栏」与「选择内容」是同一屏上的连续动作（与参考图一致）。
   */
  rightPanelView: RightPanelView | null;

  /**
   * 展开 / 收起面板。
   *
   * **这是面板唯一的开合入口**（面板内部刻意没有收起按钮）：顶栏那颗开关
   * 一直在屏幕上，而面板内的按钮只在展开时存在 —— 把动作放在始终可见的那一处，
   * 同一个意图就不会有两个入口。
   */
  toggleRightPanel(): void;
  /** 切到某个视图。**只切不关**：面板内的点击是「换个内容」，想收起用顶栏那颗开关 */
  openRightPanel(view: RightPanelView): void;
  /** 回到选择列表（面板保持展开）：这是「换一个内容」，与收起是两件事 */
  showRightPanelChooser(): void;

  toggleSidebar(): void;
  openSearch(): void;
  closeSearch(): void;
  openSettings(section?: SettingsSection): void;
  closeSettings(): void;
  /** 记录一次消息跳转请求；token 自增让同一目标也能重新触发定位 */
  jumpToMessage(sessionId: string, messageId: string): void;
  /** 丢弃当前跳转目标；离开目标会话后由 Thread 调用，避免残留标记 */
  clearSearchJump(): void;
  /**
   * 请求删除会话，返回用户是否确认。
   * 官方 thread-list 的 Delete 是会立刻执行的，删除又是不可撤销的磁盘操作，
   * 因此把确认拦在这里：确认框关闭前不真正删除。
   */
  requestDeleteSession(id: string): Promise<boolean>;
  /** 由确认对话框调用：记录用户选择并关闭对话框 */
  settleDeleteSession(confirmed: boolean): void;
  /** 打开某条用户消息的编辑模态 */
  beginEditMessage(id: string): void;
  closeEditMessage(): void;
}

export const useUiStore = create<UiState>()((set, get) => ({
  sidebarCollapsed: false,
  searchOpen: false,
  settingsOpen: false,
  settingsSection: "general",
  searchJump: null,
  rightPanelOpen: false,
  rightPanelView: null,
  pendingDeleteSessionId: null,
  resolveDeleteSession: null,
  editingMessageId: null,

  toggleRightPanel: () => set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

  // 只切不关：面板内的点击是「换个内容」，用户要看的是新内容。
  // 收起由顶栏那颗开关负责（它始终可见），这里不重复这个动作。
  openRightPanel: (view) => set({ rightPanelOpen: true, rightPanelView: view }),

  showRightPanelChooser: () => set({ rightPanelView: null }),

  toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  openSearch: () => set({ searchOpen: true }),
  closeSearch: () => set({ searchOpen: false }),
  openSettings: (section) => set({ settingsOpen: true, settingsSection: section ?? "general" }),
  closeSettings: () => set({ settingsOpen: false }),

  jumpToMessage: (sessionId, messageId) => {
    searchJumpSeq += 1;
    set({ searchJump: { sessionId, messageId, token: searchJumpSeq } });
  },

  clearSearchJump: () => set({ searchJump: null }),

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

  beginEditMessage: (id) => set({ editingMessageId: id }),
  closeEditMessage: () => set({ editingMessageId: null }),
}));
